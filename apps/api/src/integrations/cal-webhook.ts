import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { bookingIdentity, bookingIdentityMessage } from '../booking/booking-identity';
import { tokenHash } from '../auth/security';
import { db } from '../database/client';
import { cancelPendingJobs, lockAppointment, queueJob } from '../whatsapp/queue';

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
        email: z.string().optional(),
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
    const existing = await tx.appointment.findUnique({ where: { calUid: uid }, include: { user: true } });
    let rescheduledFrom: typeof existing = null;
    if (cancelled) {
      if (existing) {
        await lockAppointment(tx, existing.id);
        await tx.appointment.update({
          where: { id: existing.id },
          data: {
            status: 'CANCELLED',
            calStatus: 'cancelled',
            automationRevision: { increment: 1 },
          },
        });
        await cancelPendingJobs(tx, existing.id);
      }
      await saveEvent('CANCELLED');
      return { ok: true };
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
    const data = details.safeParse(event.payload);
    if (!data.success) throw new BadRequestException('Faltan datos de la reserva');
    const p = data.data;
    const start = new Date(p.startTime),
      end = new Date(p.endTime);
    if (end <= start) throw new BadRequestException('Horario inválido');
    const phoneValue = p.responses.attendeePhoneNumber?.value ?? p.attendees[0].phoneNumber;
    const reference = p.metadata.instafixReference;
    const hasReference = reference !== undefined && reference !== null && reference !== '';
    const intent = typeof reference === 'string' && reference.length <= 200
      ? await tx.bookingIntent.findUnique({ where: { tokenHash: tokenHash(reference) }, include: { user: true } })
      : !hasReference
        ? await tx.bookingIntent.findUnique({ where: { calUid: uid }, include: { user: true } })
        : null;
    const validIntent = intent && (intent.calUid
      ? intent.calUid === uid || intent.calUid === event.payload.rescheduleUid
      : intent.createdAt.getTime() <= occurredAt.getTime() + 300000 && intent.expiresAt >= occurredAt);
    const selected = validIntent ? intent : null;
    // La relación ya establecida sobrevive eventos sin metadata y reprogramaciones.
    const previousOwner = existing?.user || rescheduledFrom?.user || null;
    const owner = previousOwner || selected?.user || null;
    const identity = bookingIdentity({
      owner,
      invalidReference: hasReference && !validIntent,
      ownerConflict: Boolean(previousOwner && selected?.user && previousOwner.id !== selected.user.id),
      phone: phoneValue, email: p.attendees[0].email, name: p.attendees[0].name,
    });
    const phone = identity.contactPhone;
    const service = p.responses.servicio?.value;
    const consent = p.responses.whatsappConsent?.value === true;
    const title = typeof service === 'string' && service.trim() ? service.trim().slice(0, 150) : '';
    const issue = identity.bookingIdentityIssue ? bookingIdentityMessage : !phone
      ? 'Falta un teléfono válido en Cal.com'
      : !consent
        ? 'Falta autorización de WhatsApp en Cal.com'
        : !title
          ? 'Falta la descripción del trabajo (campo servicio)'
          : null;
    const calStatus = (
      p.status || (event.triggerEvent === 'BOOKING_REQUESTED' ? 'PENDING' : 'ACCEPTED')
    ).toLowerCase();
    if (selected && identity.bookingIdentityIssue !== 'OWNER_CONFLICT') {
      await tx.bookingIntent.update({ where: { tokenHash: selected.tokenHash }, data: { calUid: uid } });
    }
    if (existing) {
      await lockAppointment(tx, existing.id);
      // BOOKING_CREATED tras confirmar no debe volver a pedir la ubicación.
      const current = await tx.appointment.findUniqueOrThrow({ where: { id: existing.id } });
      if (['CANCELLED', 'COMPLETED', 'IN_PROGRESS'].includes(current.status)) {
        // No reabrir trabajos terminados ni perder un vínculo recuperado.
        if (!current.userId && identity.userId)
          await tx.appointment.update({ where: { id: current.id }, data: { userId: identity.userId } });
        await saveEvent('IGNORED_CANCELLED');
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
        await tx.appointment.update({ where: { id: current.id }, data: { calStatus, userId: identity.userId } });
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
      technician: existing?.technician || rescheduledFrom?.technician || '',
      status: 'PENDING_LOCATION' as const,
      whatsappConsentAt: consent ? occurredAt : null,
      calStatus,
      automationIssue: issue,
      locationLatitude: null,
      locationLongitude: null,
      locationReceivedAt: null,
      locationRequestedAt: occurredAt,
    };
    const appointment = existing
      ? await tx.appointment.update({
          where: { id: existing.id },
          data: { ...dataToSave, automationRevision: { increment: 1 } },
        })
      : await tx.appointment.create({ data: { ...dataToSave, calUid: uid } });
    if (!issue) await queueJob(tx, appointment, 'INITIAL', new Date());
    await saveEvent(issue ? 'NEEDS_REVIEW' : 'IMPORTED');
    return { ok: true };
  });
}
