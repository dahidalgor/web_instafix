import {
  BadGatewayException,
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
  dayIn,
  firstBookableDay,
  isCalSlotAvailable,
  rescheduleCalBooking,
  type CalBooking,
  type CalHttpError,
} from '../integrations/cal-client';
import { logEvent } from '../common/log-event';
import { ProviderError } from '../integrations/provider-error';
import { publishAppointmentEvent } from '../notifications/appointment-events';
import { deliverNotification } from '../notifications/notification.service';
import { cancelPendingJobs, lockAppointment, queueJob } from '../whatsapp/queue';
import { assertPhoneAllowed } from '../security/blocked-phones';
import type { RequestOrigin } from '../security/client-identity';
import { exclusive } from '../security/idempotency';
import { rateLimited } from '../security/rate-events';
import { WEB_CONSENT_ISSUE } from '../whatsapp/consent';

/** Regla de negocio: una cita se reprograma como máximo 2 veces. */
export const MAX_RESCHEDULES = 2;
export const rescheduleLimitMessage =
  'Esta cita alcanzó el límite de reagendamientos. Si necesitas otro horario, cancela la cita y solicita una nueva.';
/** Límites contra abuso de reservas (cada una ocupa la agenda y dispara avisos). */
export const BOOKING_LIMITS = { perPhoneDay: 3, perIpDay: 6, activePerPhone: 3 };
const activeStatuses = ['PENDING_LOCATION', 'CONFIRMED', 'IN_PROGRESS'] as const;

/**
 * Buzón propio de Instafix (opcional). A Cal.com no se le envía ningún correo de asistente: la
 * reserva va solo con el teléfono. Este buzón solo se usa si Cal.com rechaza una reserva por
 * faltar el correo. El correo real del cliente queda solo en PostgreSQL y lo usa Instafix.
 */
export const relayEmail = () => process.env.CAL_ATTENDEE_RELAY_EMAIL?.trim().toLowerCase() || null;
/** Respaldo del buzón puente: el remitente de Instafix (SMTP_FROM). */
const fallbackAttendeeEmail = () =>
  process.env.SMTP_FROM?.match(/[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+/)?.[0].toLowerCase() || null;
/**
 * Correos que nunca son del cliente: los propios de Instafix entregados a Cal.com y los de
 * relleno que Cal.com genera en las reservas solo con teléfono (p. ej. «…@sms.cal.com»).
 */
export const isRelayEmail = (email?: string | null) => {
  const value = email?.trim().toLowerCase();
  if (!value) return false;
  const domain = value.split('@')[1] ?? '';
  return (
    value === relayEmail() ||
    value === fallbackAttendeeEmail() ||
    domain === 'cal.com' ||
    domain.endsWith('.cal.com')
  );
};
/** Cal.com rechazó la reserva porque falta el correo del asistente. */
const emailRequired = (error: unknown) => {
  if (!(error instanceof ProviderError) || error.disposition !== 'FAILED') return false;
  const { httpStatus, providerMessage } = error as CalHttpError;
  return (
    httpStatus !== undefined &&
    httpStatus >= 400 &&
    httpStatus < 500 &&
    /e-?mail/i.test(`${providerMessage ?? ''} ${error.message}`)
  );
};

/** Al reprogramar, la cita vuelve a «pendiente de confirmación» y sin técnico. */
export const unassignedForReschedule = {
  status: 'PENDING_LOCATION' as const,
  assignedTechnicianId: null,
  technician: '',
  confirmedAt: null,
  confirmedById: null,
};

type Customer = { id: string; name: string; phone: string; email: string | null } | null;

/** Hora de Ecuador legible para los registros (sin datos del cliente). */
const localTime = (instant: Date) =>
  new Intl.DateTimeFormat('es-EC', {
    timeZone: 'America/Guayaquil',
    dateStyle: 'short',
    timeStyle: 'short',
    hourCycle: 'h23',
  }).format(instant);

/** Error con código estable: la web distingue «horario ocupado» del resto de fallos. */
const coded = (Type: new (body: object) => HttpException, code: string, message: string) =>
  new Type({ statusCode: new Type({}).getStatus(), code, message });
/** Regla de Instafix: se agenda a partir de mañana (fecha de Ecuador). */
function assertBookableDay(start: Date) {
  if (dayIn(start) < firstBookableDay())
    throw coded(
      BadRequestException,
      'BOOKING_TOO_SOON',
      'Las citas se agendan a partir de mañana. Elige otro día.',
    );
}
export const slotTaken = () =>
  coded(
    ConflictException,
    'SLOT_UNAVAILABLE',
    'Este horario acaba de dejar de estar disponible. Selecciona otro.',
  );

/**
 * Clasifica el rechazo de Cal.com. Solo se informa «horario ocupado» con evidencia: después del
 * rechazo, la disponibilidad real ya no ofrece ese instante. Cualquier otro 4xx (clave, permisos,
 * tipo de evento, campos de la reserva) es un problema de configuración y se registra con su motivo.
 */
async function calFailure(error: unknown, start?: Date): Promise<never> {
  const failure = error as CalHttpError;
  const status = failure instanceof ProviderError ? failure.httpStatus : undefined;
  logEvent(
    'booking.cal_rejected',
    {
      start: start?.toISOString(),
      local: start ? localTime(start) : undefined,
      calStatus: status ?? null,
      disposition: failure instanceof ProviderError ? failure.disposition : 'UNKNOWN',
      reason:
        failure instanceof ProviderError
          ? failure.providerMessage || failure.message
          : 'Error inesperado',
    },
    'warn',
  );
  if (failure instanceof ProviderError) {
    if (failure.disposition === 'REVIEW')
      throw new ServiceUnavailableException(
        'No pudimos confirmar si la reserva se completó. Revisa Mi cuenta en unos minutos o escríbenos por WhatsApp antes de intentarlo otra vez.',
      );
    if (status === 401 || status === 403)
      throw coded(
        ServiceUnavailableException,
        'BOOKING_CONFIG',
        'La agenda no acepta reservas en este momento por un problema de configuración. Escríbenos por WhatsApp y te agendamos.',
      );
    if (failure.disposition === 'FAILED' && status && start) {
      const check = await isCalSlotAvailable(start).catch(() => null);
      logEvent('booking.recheck_after_reject', {
        start: start.toISOString(),
        available: check?.available ?? null,
        offered: check?.offered ?? null,
      });
      if (check && !check.available) throw slotTaken();
      throw coded(
        BadGatewayException,
        'BOOKING_REJECTED',
        'La agenda rechazó la reserva aunque el horario sigue libre. No es un problema de tu elección: inténtalo de nuevo en unos minutos o escríbenos por WhatsApp.',
      );
    }
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
  origin: RequestOrigin | null = null,
): Promise<BookingResult> {
  const start = new Date(input.start);
  if (start.getTime() < Date.now() + 15 * 60000)
    throw new BadRequestException('Elige un horario futuro.');
  assertBookableDay(start);
  const name = customer?.name || input.name?.trim();
  const phone = customer ? customer.phone : normalizePhone(input.phone || '', 'EC');
  const email = (customer ? customer.email : input.email?.trim().toLowerCase()) || null;
  if (!name || !phone) throw new BadRequestException('Revisa tu nombre y tu número de WhatsApp.');
  await assertPhoneAllowed(phone, 'booking');
  // Doble clic, recarga o reintento: la misma reserva reciente se devuelve sin crear otra.
  const duplicate = await db.appointment.findFirst({
    where: {
      contactPhone: phone,
      startsAt: start,
      deletedAt: null,
      status: { in: [...activeStatuses] },
      createdAt: { gt: new Date(Date.now() - 15 * 60000) },
    },
  });
  if (duplicate) {
    logEvent('booking.duplicate_ignored', { appointmentId: duplicate.id });
    return bookingResult(duplicate, customer, email, false, false, phone);
  }
  await assertBookingQuota(phone, origin);
  // El correo del cliente es opcional (sin él se coordina por WhatsApp) y nunca va a Cal.com:
  // la reserva se crea solo con el teléfono y los avisos los envía Instafix por Brevo.

  // Referencia opaca para conciliar el webhook si la respuesta de Cal.com se pierde.
  const reference = newToken();
  await db.bookingIntent.create({
    data: {
      tokenHash: tokenHash(reference),
      userId: customer?.id ?? null,
      expiresAt: new Date(Date.now() + 86400000),
    },
  });

  // Revalidación: el horario debe seguir en la disponibilidad actual de Cal.com (sin caché).
  const recheck = await isCalSlotAvailable(start).catch(() => null);
  logEvent('booking.revalidated', {
    start: start.toISOString(),
    local: localTime(start),
    day: recheck?.day ?? null,
    available: recheck?.available ?? null,
    offered: recheck?.offered ?? null,
  });
  if (recheck && !recheck.available) throw slotTaken();

  let booking: CalBooking;
  const calInput = {
    start,
    name,
    phone,
    request: input.request,
    whatsappConsent: input.whatsappConsent,
    reference,
  };
  try {
    booking = await createCalBooking(calInput);
  } catch (error) {
    // Respaldo: si el tipo de evento de Cal.com volviera a exigir correo, se reintenta una vez
    // con el buzón propio de Instafix (nunca el del cliente) para no dejar de recibir citas.
    const fallback = relayEmail() || fallbackAttendeeEmail();
    if (!emailRequired(error) || !fallback) return calFailure(error, start);
    logEvent(
      'booking.cal_email_required',
      { hint: 'Cal.com pidió un correo de asistente: revisar las preguntas del tipo de evento' },
      'warn',
    );
    try {
      booking = await createCalBooking({ ...calInput, email: fallback });
    } catch (retry) {
      return calFailure(retry, start);
    }
  }
  logEvent('booking.cal_created', {
    start: booking.start.toISOString(),
    calStatus: booking.status,
  });

  const now = new Date();
  let appointment: Appointment;
  let notifications: string[] = [];
  try {
    ({ appointment, notifications } = await db.$transaction(async (tx) => {
      await calLock(tx);
      const fields = {
        source: 'INSTAFIX_API',
        userId: customer?.id ?? null,
        originSessionKey: origin?.sessionKey ?? null,
        originIpHash: origin?.ipHash ?? null,
        contactName: name,
        contactPhone: phone,
        contactEmail: email,
        title: input.request.slice(0, 500),
        startsAt: booking.start,
        endsAt: booking.end,
        calStatus: booking.status,
        whatsappConsentAt: input.whatsappConsent ? now : null,
        bookingIdentityIssue: null,
        automationIssue: input.whatsappConsent ? null : WEB_CONSENT_ISSUE,
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
        await queueJob(tx, saved, 'INITIAL', now, saved.startsAt, origin);
      await markCalEvent(tx, booking.uid, 'CREATED_BY_API', now);
      return {
        appointment: saved,
        notifications: await publishAppointmentEvent(
          tx,
          saved,
          { type: 'appointment.created' },
          now,
          origin,
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
  return bookingResult(appointment, customer, email, sent, notifications.length > 0, phone);
}

/** Respuesta pública de una reserva (también para un reintento de la misma). */
async function bookingResult(
  appointment: Appointment,
  customer: Customer,
  email: string | null,
  sent: boolean,
  queued: boolean,
  phone: string,
): Promise<BookingResult> {
  // Solo se indica si el número ya tiene cuenta (para «Inicia sesión»), sin ningún dato de ella.
  const hasAccount = customer ? false : Boolean(await db.user.findUnique({ where: { phone } }));
  return {
    appointmentId: appointment.id,
    startsAt: appointment.startsAt.toISOString(),
    endsAt: appointment.endsAt.toISOString(),
    status: appointment.status,
    email: {
      status: sent ? 'SENT' : queued ? 'PENDING' : 'NONE',
      maskedEmail: email && queued ? maskEmail(email) : null,
    },
    account: customer ? 'LINKED' : hasAccount ? 'EXISTING_ACCOUNT' : 'GUEST',
  };
}

/** Reservas por número e IP en 24 h y citas activas por número (antes de llamar a Cal.com). */
async function assertBookingQuota(phone: string, origin: RequestOrigin | null) {
  const since = new Date(Date.now() - 86400000);
  const [byPhone, byIp, active] = await Promise.all([
    db.appointment.count({ where: { contactPhone: phone, createdAt: { gt: since } } }),
    origin?.ipHash
      ? db.appointment.count({ where: { originIpHash: origin.ipHash, createdAt: { gt: since } } })
      : 0,
    db.appointment.count({
      where: {
        contactPhone: phone,
        deletedAt: null,
        status: { in: [...activeStatuses] },
        endsAt: { gt: new Date() },
      },
    }),
  ]);
  if (active >= BOOKING_LIMITS.activePerPhone)
    throw coded(
      ConflictException,
      'TOO_MANY_ACTIVE_BOOKINGS',
      'Este número ya tiene varias citas activas. Gestiónalas desde Mi cuenta o escríbenos por WhatsApp.',
    );
  if (byPhone >= BOOKING_LIMITS.perPhoneDay || byIp >= BOOKING_LIMITS.perIpDay)
    throw rateLimited(
      'BOOKING_LIMIT',
      'Alcanzaste el máximo de reservas por hoy. Si necesitas otra visita, escríbenos por WhatsApp.',
      { scope: byPhone >= BOOKING_LIMITS.perPhoneDay ? 'phone' : 'ip' },
    );
}

async function ownedChangeable(userId: string, id: string) {
  const appointment = await db.appointment.findFirst({ where: { id, userId, deletedAt: null } });
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

/**
 * Solo se registra y notifica la cancelación después de que Cal.com la confirme. Repetirla
 * (doble clic, reintento) devuelve el mismo resultado sin otro aviso. La cancelación nunca
 * depende de que haya presupuesto de WhatsApp: el aviso se evalúa después, en el worker.
 */
export async function cancelBooking(
  userId: string,
  id: string,
  origin: RequestOrigin | null = null,
) {
  const already = await db.appointment.findFirst({
    where: { id, userId, deletedAt: null, status: 'CANCELLED' },
  });
  if (already) return { ok: true, alreadyCancelled: true, emailSent: false };
  return exclusive(`appointment:${id}`, async () => {
    const appointment = await ownedChangeable(userId, id);
    try {
      await cancelCalBooking(appointment.calUid, 'Cancelada por el cliente desde Instafix');
    } catch (error) {
      return calFailure(error);
    }
    const now = new Date();
    const notifications = await db.$transaction(async (tx) => {
      await calLock(tx);
      await lockAppointment(tx, appointment.id);
      // Transición real: solo desde un estado activo (CANCELLED → CANCELLED no avisa).
      const moved = await tx.appointment.updateMany({
        where: { id: appointment.id, status: { in: ['PENDING_LOCATION', 'CONFIRMED'] } },
        data: { status: 'CANCELLED', calStatus: 'cancelled', automationRevision: { increment: 1 } },
      });
      if (!moved.count) return [] as string[];
      const updated = await tx.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
      await cancelPendingJobs(tx, appointment.id);
      await markCalEvent(tx, appointment.calUid, 'CANCELLED', now);
      return publishAppointmentEvent(tx, updated, { type: 'appointment.cancelled' }, now, origin);
    });
    return { ok: true, alreadyCancelled: false, emailSent: await deliverNow(notifications) };
  });
}

/**
 * Reprograma en Cal.com y mantiene la misma cita de Instafix con el nuevo uid. Máximo
 * MAX_RESCHEDULES por cita (regla de negocio, independiente del presupuesto de WhatsApp).
 * Orden: validar cita → límite → horario → Cal.com → DB (contador en la misma transacción) →
 * aviso encolado, que el worker envía u omite según el presupuesto.
 */
export async function rescheduleBooking(
  userId: string,
  id: string,
  startValue: string,
  origin: RequestOrigin | null = null,
) {
  const start = new Date(startValue);
  return exclusive(`appointment:${id}`, async () => {
    const appointment = await ownedChangeable(userId, id);
    // Mismo horario (reintento de una reprogramación ya hecha): nada que cambiar ni avisar.
    if (appointment.startsAt.getTime() === start.getTime())
      return {
        ok: true,
        startsAt: appointment.startsAt.toISOString(),
        emailSent: false,
        unchanged: true,
      };
    if (appointment.rescheduleCount >= MAX_RESCHEDULES) {
      logEvent('booking.reschedule_limit', { appointmentId: appointment.id }, 'warn');
      throw coded(BadRequestException, 'RESCHEDULE_LIMIT', rescheduleLimitMessage);
    }
    if (start.getTime() < Date.now() + 15 * 60000)
      throw new BadRequestException('Elige un horario futuro.');
    assertBookableDay(start);
    const recheck = await isCalSlotAvailable(start).catch(() => null);
    if (recheck && !recheck.available) throw slotTaken();
    let booking: CalBooking;
    try {
      booking = await rescheduleCalBooking(
        appointment.calUid,
        start,
        'Reprogramada por el cliente desde Instafix',
      );
    } catch (error) {
      return calFailure(error, start);
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
      // Contador y horario en una sola actualización condicionada: sin carreras.
      const moved = await tx.appointment.updateMany({
        where: { id: appointment.id, rescheduleCount: { lt: MAX_RESCHEDULES } },
        data: {
          calUid: booking.uid,
          calStatus: booking.status,
          startsAt: booking.start,
          endsAt: booking.end,
          rescheduleCount: { increment: 1 },
          automationRevision: { increment: 1 },
          ...unassignedForReschedule,
          locationRequestedAt: now,
        },
      });
      if (!moved.count)
        throw coded(BadRequestException, 'RESCHEDULE_LIMIT', rescheduleLimitMessage);
      const updated = await tx.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
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
      if (!hasLocation && updated.whatsappConsentAt)
        await queueJob(tx, updated, 'INITIAL', now, updated.startsAt, origin);
      return publishAppointmentEvent(
        tx,
        updated,
        { type: 'appointment.rescheduled', previousStartsAt: appointment.startsAt },
        now,
        origin,
      );
    });
    return {
      ok: true,
      startsAt: booking.start.toISOString(),
      emailSent: await deliverNow(notifications),
      unchanged: false,
    };
  });
}
