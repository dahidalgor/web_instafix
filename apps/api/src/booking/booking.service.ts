import {
  BadRequestException,
  ConflictException,
  HttpException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Appointment, Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { maskEmail, normalizePhone } from '@instafix/contracts/src/phone';
import type { BookingResult } from '@instafix/contracts';
import { newToken, tokenHash } from '../auth/security';
import { db } from '../database/client';
import {
  cancelCalBooking,
  createCalBooking,
  rescheduleCalBooking,
  type CalBooking,
} from '../integrations/cal-client';
import { ProviderError } from '../integrations/provider-error';
import { publishAppointmentEvent } from '../notifications/appointment-events';
import { deliverNotification } from '../notifications/notification.service';
import { cancelPendingJobs, lockAppointment, queueJob } from '../whatsapp/queue';

/**
 * Buzón propio de Instafix que se entrega a Cal.com como correo del asistente. Así Cal.com
 * no puede escribir al cliente (confirmación, solicitud, reprogramación o cancelación):
 * el correo real queda solo en PostgreSQL y lo usa Instafix.
 */
export const relayEmail = () => process.env.CAL_ATTENDEE_RELAY_EMAIL?.trim().toLowerCase() || null;
export const isRelayEmail = (email?: string | null) =>
  Boolean(email && relayEmail() && email.trim().toLowerCase() === relayEmail());

/** Al reprogramar, la cita vuelve a «pendiente de confirmación» y sin técnico. */
export const unassignedForReschedule = {
  status: 'PENDING_LOCATION' as const,
  assignedTechnicianId: null,
  technician: '',
  confirmedAt: null,
  confirmedById: null,
};

type Customer = { id: string; name: string; phone: string; email: string | null } | null;

function calFailure(error: unknown): never {
  if (error instanceof ProviderError) {
    if (error.disposition === 'REVIEW')
      throw new ServiceUnavailableException(
        'No pudimos confirmar si la reserva se completó. Revisa Mi cuenta en unos minutos o escríbenos por WhatsApp antes de intentarlo otra vez.',
      );
    if (error.disposition === 'FAILED' && (error as { httpStatus?: number }).httpStatus)
      throw new ConflictException(
        'Ese horario ya no está disponible o no pudo reservarse. Elige otro horario.',
      );
  }
  throw new ServiceUnavailableException('La agenda no está disponible en este momento.');
}

const calLock = (tx: Prisma.TransactionClient) =>
  // Mismo bloqueo que el webhook de Cal.com: ordena la API y el webhook del mismo hecho.
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('cal-webhooks'))`;

async function markCalEvent(
  tx: Prisma.TransactionClient,
  uid: string,
  outcome: string,
  occurredAt: Date,
) {
  const id = 'api:' + createHash('sha256').update(`${outcome}:${uid}`).digest('hex');
  await tx.integrationEvent.upsert({
    where: { id },
    update: {},
    create: { id, provider: 'CAL', sourceId: uid, occurredAt, outcome },
  });
}

async function deliverNow(ids: string[]) {
  let sent = false;
  for (const id of ids) {
    try {
      sent = (await deliverNotification(id)) === 'SENT' || sent;
    } catch {
      // La bandeja reintentará; la respuesta no afirma un envío que no ocurrió.
    }
  }
  return sent;
}

/** Cliente → Instafix → Cal.com API → PostgreSQL → avisos de Instafix. */
export async function createBooking(
  input: {
    start: string;
    name?: string;
    email?: string;
    phone?: string;
    request: string;
    whatsappConsent: boolean;
  },
  customer: Customer,
): Promise<BookingResult> {
  const start = new Date(input.start);
  if (start.getTime() < Date.now() + 15 * 60000)
    throw new BadRequestException('Elige un horario futuro.');
  const name = customer?.name || input.name?.trim();
  const phone = customer ? customer.phone : normalizePhone(input.phone || '', 'EC');
  const email = (customer ? customer.email : input.email?.trim().toLowerCase()) || null;
  if (!name || !phone) throw new BadRequestException('Revisa tu nombre y tu número de WhatsApp.');
  const attendeeEmail = relayEmail() || email;
  if (!attendeeEmail)
    throw new BadRequestException('Escribe un correo para recibir la confirmación de tu cita.');

  // Referencia opaca para conciliar el webhook si la respuesta de Cal.com se pierde.
  const reference = newToken();
  await db.bookingIntent.create({
    data: {
      tokenHash: tokenHash(reference),
      userId: customer?.id ?? null,
      expiresAt: new Date(Date.now() + 86400000),
    },
  });

  let booking: CalBooking;
  try {
    booking = await createCalBooking({
      start,
      name,
      email: attendeeEmail,
      phone,
      request: input.request,
      whatsappConsent: input.whatsappConsent,
      reference,
    });
  } catch (error) {
    calFailure(error);
  }

  const now = new Date();
  let appointment: Appointment;
  let notifications: string[] = [];
  try {
    ({ appointment, notifications } = await db.$transaction(async (tx) => {
      await calLock(tx);
      const fields = {
        source: 'INSTAFIX_API',
        userId: customer?.id ?? null,
        contactName: name,
        contactPhone: phone,
        contactEmail: email,
        title: input.request.slice(0, 500),
        startsAt: booking.start,
        endsAt: booking.end,
        calStatus: booking.status,
        whatsappConsentAt: input.whatsappConsent ? now : null,
        bookingIdentityIssue: null,
        automationIssue: input.whatsappConsent
          ? null
          : 'Sin autorización de WhatsApp: coordinar la ubicación manualmente.',
      };
      // El webhook pudo llegar antes que esta respuesta: se completa esa misma fila.
      const existing = await tx.appointment.findUnique({ where: { calUid: booking.uid } });
      const saved = existing
        ? await tx.appointment.update({ where: { id: existing.id }, data: fields })
        : await tx.appointment.create({
            data: {
              ...fields,
              calUid: booking.uid,
              device: 'Por especificar',
              address: '',
              technician: '',
              // Agendada ≠ confirmada: la confirma un técnico desde su panel.
              status: 'PENDING_LOCATION',
              timeZone: 'America/Guayaquil',
              locationRequestedAt: now,
            },
          });
      await tx.bookingIntent.update({
        where: { tokenHash: tokenHash(reference) },
        data: { calUid: booking.uid },
      });
      if (saved.whatsappConsentAt && saved.status === 'PENDING_LOCATION')
        await queueJob(tx, saved, 'INITIAL', now);
      await markCalEvent(tx, booking.uid, 'CREATED_BY_API', now);
      return {
        appointment: saved,
        notifications: await publishAppointmentEvent(
          tx,
          saved,
          { type: 'appointment.created' },
          now,
        ),
      };
    }));
  } catch (error) {
    // La reserva existe en Cal.com pero no en Instafix: se libera para no dejar un hueco.
    await cancelCalBooking(booking.uid, 'No se pudo registrar la reserva en Instafix').catch(() =>
      console.error('Reserva Cal.com sin registrar: revisar manualmente'),
    );
    if (error instanceof HttpException) throw error;
    throw new ServiceUnavailableException('No pudimos registrar tu cita. Inténtalo de nuevo.');
  }

  const sent = await deliverNow(notifications);
  return {
    appointmentId: appointment.id,
    startsAt: appointment.startsAt.toISOString(),
    endsAt: appointment.endsAt.toISOString(),
    status: appointment.status,
    email: {
      status: sent ? 'SENT' : notifications.length ? 'PENDING' : 'NONE',
      maskedEmail: email && notifications.length ? maskEmail(email) : null,
    },
    account: customer ? 'LINKED' : 'GUEST',
  };
}

async function ownedChangeable(userId: string, id: string) {
  const appointment = await db.appointment.findFirst({ where: { id, userId } });
  if (
    !appointment ||
    !appointment.calUid ||
    !['PENDING_LOCATION', 'CONFIRMED'].includes(appointment.status) ||
    appointment.startsAt <= new Date()
  )
    throw new BadRequestException(
      'Esta cita ya no puede modificarse desde aquí. Escríbenos por WhatsApp.',
    );
  return appointment as Appointment & { calUid: string };
}

/** Solo se registra y notifica la cancelación después de que Cal.com la confirme. */
export async function cancelBooking(userId: string, id: string) {
  const appointment = await ownedChangeable(userId, id);
  try {
    await cancelCalBooking(appointment.calUid, 'Cancelada por el cliente desde Instafix');
  } catch (error) {
    calFailure(error);
  }
  const now = new Date();
  const notifications = await db.$transaction(async (tx) => {
    await calLock(tx);
    await lockAppointment(tx, appointment.id);
    const updated = await tx.appointment.update({
      where: { id: appointment.id },
      data: { status: 'CANCELLED', calStatus: 'cancelled', automationRevision: { increment: 1 } },
    });
    await cancelPendingJobs(tx, appointment.id);
    await markCalEvent(tx, appointment.calUid, 'CANCELLED', now);
    return publishAppointmentEvent(tx, updated, { type: 'appointment.cancelled' }, now);
  });
  return { ok: true, emailSent: await deliverNow(notifications) };
}

/** Reprograma en Cal.com y mantiene la misma cita de Instafix con el nuevo uid. */
export async function rescheduleBooking(userId: string, id: string, startValue: string) {
  const appointment = await ownedChangeable(userId, id);
  const start = new Date(startValue);
  if (start.getTime() < Date.now() + 15 * 60000)
    throw new BadRequestException('Elige un horario futuro.');
  let booking: CalBooking;
  try {
    booking = await rescheduleCalBooking(
      appointment.calUid,
      start,
      'Reprogramada por el cliente desde Instafix',
    );
  } catch (error) {
    calFailure(error);
  }
  const now = new Date();
  const notifications = await db.$transaction(async (tx) => {
    await calLock(tx);
    await lockAppointment(tx, appointment.id);
    await cancelPendingJobs(tx, appointment.id);
    // El webhook pudo crear ya una fila para el nuevo uid: se descarta en favor de esta.
    const duplicate = await tx.appointment.findUnique({ where: { calUid: booking.uid } });
    if (duplicate && duplicate.id !== appointment.id) {
      await cancelPendingJobs(tx, duplicate.id);
      await tx.appointment.delete({ where: { id: duplicate.id } });
    }
    const hasLocation = Boolean(appointment.locationReceivedAt);
    // El nuevo horario vuelve a necesitar la confirmación de un técnico disponible.
    const updated = await tx.appointment.update({
      where: { id: appointment.id },
      data: {
        calUid: booking.uid,
        calStatus: booking.status,
        startsAt: booking.start,
        endsAt: booking.end,
        automationRevision: { increment: 1 },
        ...unassignedForReschedule,
        locationRequestedAt: now,
      },
    });
    await markCalEvent(tx, appointment.calUid, 'CANCELLED', now);
    await markCalEvent(tx, booking.uid, 'RESCHEDULED_BY_API', now);
    if (appointment.assignedTechnicianId)
      await tx.appointmentActivity.create({
        data: {
          appointmentId: appointment.id,
          action: 'UNASSIGNED_BY_RESCHEDULE',
          detail: { previousTechnicianId: appointment.assignedTechnicianId },
        },
      });
    if (!hasLocation && updated.whatsappConsentAt) await queueJob(tx, updated, 'INITIAL', now);
    return publishAppointmentEvent(
      tx,
      updated,
      { type: 'appointment.rescheduled', previousStartsAt: appointment.startsAt },
      now,
    );
  });
  return {
    ok: true,
    startsAt: booking.start.toISOString(),
    emailSent: await deliverNow(notifications),
  };
}
