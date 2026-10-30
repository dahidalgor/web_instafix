import type { Appointment } from '@prisma/client';
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { bookingIdentity, bookingIdentityMessage } from '../booking/booking-identity';
import { tokenHash } from '../auth/security';
import { db } from '../database/client';
import { cancelPendingJobs, lockAppointment, queueJob } from '../whatsapp/queue';
import { isRelayEmail, unassignedForReschedule } from '../booking/booking.service';
import { publishAppointmentEvent } from '../notifications/appointment-events';
import { CAL_CONSENT_ISSUE } from '../whatsapp/consent';

const envelope = z.object({
  triggerEvent: z.string(),
  createdAt: z.string().datetime({ offset: true }),
  payload: z
    .object({
      uid: z.string().min(1).max(200),
      eventTypeId: z.number(),
      rescheduleUid: z.string().max(200).optional(),
    })
    .passthrough(),
});
const details = z.object({
  startTime: z.string().datetime({ offset: true }),
  endTime: z.string().datetime({ offset: true }),
  attendees: z
    .array(
      z.object({
        name: z.string().min(1).max(100),
        phoneNumber: z.string().nullable().optional(),
        email: z.string().nullish(),
      }),
    )
    .min(1),
  responses: z.record(z.object({ value: z.unknown().optional() }).passthrough()).default({}),
  status: z.string().optional(),
  metadata: z.record(z.unknown()).default({}),
});

export async function receiveCalWebhook(body: unknown) {
  const parsed = envelope.safeParse(body);
  if (!parsed.success) throw new BadRequestException('Evento Cal inválido');
  if (!process.env.CAL_EVENT_TYPE_ID)
    throw new ServiceUnavailableException('Falta configurar el tipo de evento Cal');
  const event = parsed.data;
  if (event.payload.eventTypeId !== Number(process.env.CAL_EVENT_TYPE_ID)) return { ignored: true };
  const accepted = [
    'BOOKING_REQUESTED',
    'BOOKING_CREATED',
    'BOOKING_RESCHEDULED',
    'BOOKING_CANCELLED',
    'BOOKING_REJECTED',
  ];
  if (!accepted.includes(event.triggerEvent)) return { ignored: true };
  const occurredAt = new Date(event.createdAt);
  const uid = event.payload.uid;
  const cancelled = ['BOOKING_CANCELLED', 'BOOKING_REJECTED'].includes(event.triggerEvent);
  const id =
    'cal:' +
    createHash('sha256').update(`${event.triggerEvent}:${uid}:${event.createdAt}`).digest('hex');
  return db.$transaction(async (tx) => {
    // Ordena eventos repetidos y fuera de orden, incluyendo cancelación antes de creación.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('cal-webhooks'))`;
    if (await tx.integrationEvent.findUnique({ where: { id } })) return { duplicate: true };
    const previous = await tx.integrationEvent.findFirst({
      where: { provider: 'CAL', sourceId: uid },
      orderBy: { occurredAt: 'desc' },
    });
    const obsolete =
      previous && (previous.occurredAt > occurredAt || previous.outcome === 'CANCELLED');
    if (obsolete) return { ignored: true };
    const saveEvent = (outcome: string) =>
      tx.integrationEvent.create({
        data: { id, provider: 'CAL', sourceId: uid, occurredAt, outcome },
      });
    const existing = await tx.appointment.findUnique({
      where: { calUid: uid },
      include: { user: true },
    });
    let rescheduledFrom: typeof existing = null;
    if (cancelled) {
      if (existing) {
        await lockAppointment(tx, existing.id);
        const current = await tx.appointment.findUniqueOrThrow({ where: { id: existing.id } });
        if (current.status !== 'CANCELLED') {
          const updated = await tx.appointment.update({
            where: { id: existing.id },
            data: {
              status: 'CANCELLED',
              calStatus: 'cancelled',
              automationRevision: { increment: 1 },
            },
          });
          await cancelPendingJobs(tx, existing.id);
          // Cancelación hecha desde Cal.com: Instafix avisa al cliente (deduplicado).
          if (['PENDING_LOCATION', 'CONFIRMED'].includes(current.status))
            await publishAppointmentEvent(tx, updated, { type: 'appointment.cancelled' });
        }
      }
      await saveEvent('CANCELLED');
      return { ok: true };
    }
    const data = details.safeParse(event.payload);
    if (!data.success) throw new BadRequestException('Faltan datos de la reserva');
    const fromApi = data.data.metadata.instafixSource === 'api';
    // Reserva creada por Instafix: su fila ya es la fuente de verdad. El webhook solo
    // actualiza el estado de Cal.com y nunca genera un segundo aviso del mismo hecho.
    if (existing && existing.source === 'INSTAFIX_API' && !event.payload.rescheduleUid) {
      await tx.appointment.update({
        where: { id: existing.id },
        data: { calStatus: (data.data.status || existing.calStatus || '').toLowerCase() || null },
      });
      await saveEvent('UPDATED');
      return { ok: true };
    }
    if (event.payload.rescheduleUid && event.payload.rescheduleUid !== uid) {
      const moved =
        existing?.source === 'INSTAFIX_API'
          ? existing
          : await tx.appointment.findUnique({ where: { calUid: event.payload.rescheduleUid } });
      if (moved?.source === 'INSTAFIX_API') {
        await lockAppointment(tx, moved.id);
        const current = await tx.appointment.findUniqueOrThrow({ where: { id: moved.id } });
        const startsAt = new Date(data.data.startTime);
        const endsAt = new Date(data.data.endTime);
        if (current.calUid === uid && current.startsAt.getTime() === startsAt.getTime()) {
          // Reprogramación iniciada por Instafix y ya registrada.
          await saveEvent('UPDATED');
          return { ok: true };
        }
        if (!['PENDING_LOCATION', 'CONFIRMED'].includes(current.status)) {
          await saveEvent('IGNORED_TERMINAL');
          return { ok: true };
        }
        await cancelPendingJobs(tx, current.id);
        const status = String(data.data.status || 'accepted').toLowerCase();
        const hasLocation = Boolean(current.locationReceivedAt);
        // Reprogramada desde Cal.com: vuelve a esperar la confirmación de un técnico.
        const updated = await tx.appointment.update({
          where: { id: current.id },
          data: {
            calUid: uid,
            calStatus: status,
            startsAt,
            endsAt,
            automationRevision: { increment: 1 },
            // Reprogramada desde Cal.com (equipo): cuenta, pero no se bloquea.
            rescheduleCount: { increment: 1 },
            ...unassignedForReschedule,
            locationRequestedAt: occurredAt,
          },
        });
        if (!hasLocation && updated.whatsappConsentAt)
          await queueJob(tx, updated, 'INITIAL', new Date());
        await publishAppointmentEvent(tx, updated, {
          type: 'appointment.rescheduled',
          previousStartsAt: current.startsAt,
        });
        await tx.integrationEvent.upsert({
          where: { id: `${id}:previous` },
          update: {},
          create: {
            id: `${id}:previous`,
            provider: 'CAL',
            sourceId: event.payload.rescheduleUid,
            occurredAt,
            outcome: 'CANCELLED',
          },
        });
        await saveEvent('RESCHEDULED');
        return { ok: true };
      }
    }
    if (event.payload.rescheduleUid && event.payload.rescheduleUid !== uid) {
      const old = await tx.appointment.findUnique({
        where: { calUid: event.payload.rescheduleUid },
        include: { user: true },
      });
      rescheduledFrom = old;
      if (old) {
        await lockAppointment(tx, old.id);
        await tx.appointment.update({
          where: { id: old.id },
          data: {
            status: 'CANCELLED',
            calStatus: 'rescheduled',
            automationRevision: { increment: 1 },
          },
        });
        await cancelPendingJobs(tx, old.id);
      }
      await tx.integrationEvent.upsert({
        where: { id: `${id}:previous` },
        update: {},
        create: {
          id: `${id}:previous`,
          provider: 'CAL',
          sourceId: event.payload.rescheduleUid,
          occurredAt,
          outcome: 'CANCELLED',
        },
      });
    }
    const p = data.data;
    const start = new Date(p.startTime),
      end = new Date(p.endTime);
    if (end <= start) throw new BadRequestException('Horario inválido');
    const phoneValue = p.responses.attendeePhoneNumber?.value ?? p.attendees[0].phoneNumber;
    const reference = p.metadata.instafixReference;
    const hasReference = reference !== undefined && reference !== null && reference !== '';
    const intent =
      typeof reference === 'string' && reference.length <= 200
        ? await tx.bookingIntent.findUnique({
            where: { tokenHash: tokenHash(reference) },
            include: { user: true },
          })
        : !hasReference
          ? await tx.bookingIntent.findUnique({ where: { calUid: uid }, include: { user: true } })
          : null;
    const validIntent =
      intent &&
      (intent.calUid
        ? intent.calUid === uid || intent.calUid === event.payload.rescheduleUid
        : intent.createdAt.getTime() <= occurredAt.getTime() + 300000 &&
          intent.expiresAt >= occurredAt);
    const selected = validIntent ? intent : null;
    // La relación ya establecida sobrevive eventos sin metadata y reprogramaciones.
    const previousOwner = existing?.user || rescheduledFrom?.user || null;
    const owner = previousOwner || selected?.user || null;
    const identity = bookingIdentity({
      owner,
      invalidReference: hasReference && !validIntent,
      ownerConflict: Boolean(
        previousOwner && selected?.user && previousOwner.id !== selected.user.id,
      ),
      phone: phoneValue,
      // El buzón de reenvío de Instafix no es el correo del cliente.
      email: isRelayEmail(p.attendees[0].email) ? undefined : (p.attendees[0].email ?? undefined),
      name: p.attendees[0].name,
    });
    const phone = identity.contactPhone;
    // Reservas por API: `notes` y la autorización en metadata. Embed antiguo: campos propios.
    const service = p.responses.servicio?.value ?? p.responses.notes?.value;
    const consent =
      p.responses.whatsappConsent?.value === true || p.metadata.instafixWhatsappConsent === 'true';
    const title = typeof service === 'string' && service.trim() ? service.trim().slice(0, 150) : '';
    const issue = identity.bookingIdentityIssue
      ? bookingIdentityMessage
      : !phone
        ? 'Falta un teléfono válido en Cal.com'
        : !consent
          ? CAL_CONSENT_ISSUE
          : !title
            ? 'Falta la descripción del trabajo (campo servicio)'
            : null;
    const calStatus = (
      p.status || (event.triggerEvent === 'BOOKING_REQUESTED' ? 'PENDING' : 'ACCEPTED')
    ).toLowerCase();
    if (selected && identity.bookingIdentityIssue !== 'OWNER_CONFLICT') {
      await tx.bookingIntent.update({
        where: { tokenHash: selected.tokenHash },
        data: { calUid: uid },
      });
    }
    if (existing) {
      await lockAppointment(tx, existing.id);
      // BOOKING_CREATED tras confirmar no debe volver a pedir la ubicación.
      const current = await tx.appointment.findUniqueOrThrow({ where: { id: existing.id } });
      if (['CANCELLED', 'COMPLETED', 'IN_PROGRESS'].includes(current.status)) {
        // No reabrir trabajos terminados ni perder un vínculo recuperado.
        if (!current.userId && identity.userId)
          await tx.appointment.update({
            where: { id: current.id },
            data: { userId: identity.userId },
          });
        await saveEvent('IGNORED_TERMINAL');
        return { ok: true };
      }
      const changed =
        current.startsAt.getTime() !== start.getTime() ||
        current.endsAt.getTime() !== end.getTime() ||
        (phone || '') !== current.contactPhone ||
        (title || 'Trabajo pendiente de especificar') !== current.title ||
        consent !== Boolean(current.whatsappConsentAt) ||
        current.contactName !== identity.contactName ||
        current.bookingIdentityIssue !== identity.bookingIdentityIssue;
      if (!changed) {
        await tx.appointment.update({
          where: { id: current.id },
          data: { calStatus, userId: identity.userId },
        });
        await saveEvent('UPDATED');
        return { ok: true };
      }
      await cancelPendingJobs(tx, current.id);
    }
    // Las reservas de invitados no se vinculan a una cuenta solo por conocer su teléfono.
    const dataToSave = {
      ...identity,
      title: title || 'Trabajo pendiente de especificar',
      startsAt: start,
      endsAt: end,
      timeZone: 'America/Guayaquil',
      device: existing?.device || rescheduledFrom?.device || 'Por especificar',
      offeringId: existing?.offeringId || rescheduledFrom?.offeringId || null,
      address: existing?.address || rescheduledFrom?.address || '',
      // Un cambio de la reserva vuelve a requerir que un técnico la confirme.
      ...unassignedForReschedule,
      whatsappConsentAt: consent ? occurredAt : null,
      calStatus,
      automationIssue: issue,
      // La ubicación ya recibida sigue valiendo si el cliente (teléfono) es el mismo: un cambio
      // de horario o de estado en Cal.com no debe borrarla.
      ...keptLocation(existing ?? rescheduledFrom, phone, occurredAt),
    };
    const rescheduleCount = rescheduledFrom
      ? { rescheduleCount: rescheduledFrom.rescheduleCount + 1 }
      : {};
    const attendeeEmail = p.attendees[0].email?.trim().toLowerCase() || null;
    const contactEmail =
      (identity.userId ? owner?.email : null) ||
      (attendeeEmail && !isRelayEmail(attendeeEmail) ? attendeeEmail : null) ||
      existing?.contactEmail ||
      null;
    const appointment = existing
      ? await tx.appointment.update({
          where: { id: existing.id },
          data: { ...dataToSave, contactEmail, automationRevision: { increment: 1 } },
        })
      : await tx.appointment.create({
          data: {
            ...dataToSave,
            contactEmail,
            ...rescheduleCount,
            calUid: uid,
            // Respuesta de la API perdida: la reserva sí es de Instafix y se avisa una vez.
            source: fromApi ? 'INSTAFIX_API' : 'CAL_EMBED',
          },
        });
    if (!issue) await queueJob(tx, appointment, 'INITIAL', new Date());
    if (!existing && fromApi && !issue)
      await publishAppointmentEvent(tx, appointment, { type: 'appointment.created' });
    await saveEvent(issue ? 'NEEDS_REVIEW' : 'IMPORTED');
    return { ok: true };
  });
}

/** Ubicación de la reserva anterior (misma persona) o vacía si cambia el teléfono. */
function keptLocation(
  previous: Appointment | null | undefined,
  phone: string | null | undefined,
  occurredAt: Date,
) {
  if (previous?.locationReceivedAt && previous.contactPhone === (phone || ''))
    return {
      locationLatitude: previous.locationLatitude,
      locationLongitude: previous.locationLongitude,
      locationArea: previous.locationArea,
      locationReceivedAt: previous.locationReceivedAt,
      locationSource: previous.locationSource,
      locationName: previous.locationName,
      locationRequestedAt: previous.locationRequestedAt,
    };
  return {
    locationLatitude: null,
    locationArea: null,
    locationLongitude: null,
    locationReceivedAt: null,
    locationSource: null,
    locationName: null,
    locationRequestedAt: occurredAt,
  };
}
