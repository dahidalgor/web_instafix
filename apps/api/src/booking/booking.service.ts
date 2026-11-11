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
import { db } from '../database/client';
import {
  calEventLengthMinutes,
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
import { scheduleCompletionReminders } from '../notifications/staff/staff-notifications';
import { cancelPendingJobs, lockAppointment, queueJob, queueReminders } from '../whatsapp/queue';
import { assertPhoneAllowed } from '../security/blocked-phones';
import type { RequestOrigin } from '../security/client-identity';
import { exclusive } from '../security/idempotency';
import { rateLimited } from '../security/rate-events';
import { WEB_CONSENT_ISSUE } from '../whatsapp/consent';
import { holdDeadline, holdDeadlineForExisting, resetHold, usesHold } from './hold';

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
  // La reserva provisional empieza de nuevo (la fija quien mueve la cita o el barrido).
  ...resetHold,
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

export async function markCalEvent(
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

/** Ese horario no deja tiempo para que un técnico lo confirme antes de que venza. */
const slotTooSoon = () =>
  coded(
    ConflictException,
    'SLOT_UNAVAILABLE',
    'Ese horario ya no alcanza a confirmarse a tiempo. Elige uno más adelante.',
  );

/**
 * Citas pendientes cuyo horario está guardado solo en Instafix (reserva provisional) y que se
 * cruzan con [start, end). Cal.com no las conoce: Instafix las descuenta de su disponibilidad.
 */
export function heldAppointments(
  client: Prisma.TransactionClient,
  start: Date,
  end: Date,
  exceptId?: string,
) {
  return client.appointment.findMany({
    where: {
      status: 'PENDING_LOCATION',
      calUid: null,
      source: 'INSTAFIX_API',
      deletedAt: null,
      startsAt: { lt: end },
      endsAt: { gt: start },
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    select: { id: true, startsAt: true, endsAt: true },
  });
}

/**
 * Horarios que la web ofrece: los de Cal.com menos los ocupados por reservas provisionales de
 * Instafix y los que ya no dejan tiempo para que un técnico confirme antes de que venzan.
 */
export async function bookableSlots(days: Record<string, string[]>, now = new Date()) {
  const all = Object.values(days).flat();
  if (!all.length) return days;
  const length = (await calEventLengthMinutes()) * 60000;
  const times = all.map((slot) => new Date(slot).getTime());
  const holds = await heldAppointments(
    db,
    new Date(Math.min(...times)),
    new Date(Math.max(...times) + length),
  );
  const free = (slot: string) => {
    const start = new Date(slot);
    const end = start.getTime() + length;
    return (
      holdDeadline(now, start) !== null &&
      !holds.some((h) => h.startsAt.getTime() < end && h.endsAt > start)
    );
  };
  return Object.fromEntries(
    Object.entries(days)
      .map(([day, slots]): [string, string[]] => [day, slots.filter(free)])
      .filter(([, slots]) => slots.length),
  );
}

/**
 * El horario está libre de verdad: Cal.com lo ofrece (sin caché) y ninguna reserva provisional
 * de Instafix lo ocupa.
 */
async function assertSlotFree(start: Date, end: Date, exceptId?: string) {
  const recheck = await isCalSlotAvailable(start).catch(() => null);
  logEvent('booking.revalidated', {
    start: start.toISOString(),
    local: localTime(start),
    day: recheck?.day ?? null,
    available: recheck?.available ?? null,
    offered: recheck?.offered ?? null,
  });
  // Cal.com no respondió: se acepta igual (una caída momentánea no bloquea las reservas). Si el
  // horario ya no estuviera libre, el técnico lo verá al confirmar y administración lo moverá.
  if (!recheck) logEvent('booking.slot_unverified', { start: start.toISOString() }, 'warn');
  else if (!recheck.available) throw slotTaken();
  if ((await heldAppointments(db, start, end, exceptId)).length) throw slotTaken();
}

/**
 * Crea la reserva real en Cal.com (solo al confirmar un técnico). Sin correo del cliente: si
 * el tipo de evento volviera a exigir uno, se reintenta una vez con el buzón de Instafix.
 */
export async function createAgendaBooking(input: Parameters<typeof createCalBooking>[0]) {
  try {
    return await createCalBooking(input);
  } catch (error) {
    const fallback = relayEmail() || fallbackAttendeeEmail();
    if (!emailRequired(error) || !fallback) throw error;
    logEvent(
      'booking.cal_email_required',
      { hint: 'Cal.com pidió un correo de asistente: revisar las preguntas del tipo de evento' },
      'warn',
    );
    return createCalBooking({ ...input, email: fallback });
  }
}

/**
 * Cliente → Instafix (reserva provisional) → avisos. A Cal.com no se envía nada hasta que un
 * técnico confirma: así un cliente que no responde nunca ocupa la agenda real.
 */
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
  // El correo del cliente es opcional (sin él se coordina por WhatsApp) y nunca va a Cal.com.
  const now = new Date();
  const deadline = holdDeadline(now, start);
  if (!deadline) throw slotTooSoon();
  const end = new Date(start.getTime() + (await calEventLengthMinutes()) * 60000);
  await assertSlotFree(start, end);

  const { appointment, notifications } = await db.$transaction(async (tx) => {
    // Ordena reservas simultáneas: dos clientes no pueden quedarse el mismo horario.
    await calLock(tx);
    if ((await heldAppointments(tx, start, end)).length) throw slotTaken();
    const saved = await tx.appointment.create({
      data: {
        source: 'INSTAFIX_API',
        userId: customer?.id ?? null,
        originSessionKey: origin?.sessionKey ?? null,
        originIpHash: origin?.ipHash ?? null,
        contactName: name,
        contactPhone: phone,
        contactEmail: email,
        title: input.request.slice(0, 500),
        startsAt: start,
        endsAt: end,
        whatsappConsentAt: input.whatsappConsent ? now : null,
        automationIssue: input.whatsappConsent ? null : WEB_CONSENT_ISSUE,
        device: 'Por especificar',
        address: '',
        technician: '',
        // Agendada ≠ confirmada: la confirma un técnico desde su panel.
        status: 'PENDING_LOCATION',
        timeZone: 'America/Guayaquil',
        locationRequestedAt: now,
        holdStartedAt: now,
        holdExpiresAt: deadline,
      },
    });
    if (saved.whatsappConsentAt) await queueJob(tx, saved, 'INITIAL', now, saved.startsAt, origin);
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
  });
  logEvent('booking.held', {
    appointmentId: appointment.id,
    start: start.toISOString(),
    holdExpiresAt: deadline.toISOString(),
  });
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
    !usesHold(appointment) ||
    !['PENDING_LOCATION', 'CONFIRMED'].includes(appointment.status) ||
    appointment.startsAt <= new Date()
  )
    throw new BadRequestException(
      'Esta cita ya no puede modificarse desde aquí. Escríbenos por WhatsApp.',
    );
  return appointment;
}

/**
 * Libera en Cal.com una reserva que Instafix ya dejó de usar. Si Cal.com no responde, la cita
 * queda marcada para que administración la cancele allí (el horario seguiría ocupado).
 */
async function releaseCalBooking(appointmentId: string, uid: string, reason: string) {
  try {
    await cancelCalBooking(uid, reason);
  } catch {
    logEvent('booking.cal_release_failed', { appointmentId }, 'warn');
    await db.appointment.updateMany({
      where: { id: appointmentId, automationIssue: null },
      data: {
        automationIssue:
          'No se pudo liberar la reserva anterior en Cal.com: cancélala allí para no ocupar ese horario.',
      },
    });
  }
}

/**
 * Solo se registra y notifica la cancelación después de que Cal.com la confirme (si la cita ya
 * estaba en Cal.com). Repetirla devuelve el mismo resultado sin otro aviso. La cancelación nunca
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
    // Una reserva provisional no está en Cal.com: basta con liberarla en Instafix.
    if (appointment.calUid)
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
        data: {
          status: 'CANCELLED',
          calStatus: appointment.calUid ? 'cancelled' : null,
          automationRevision: { increment: 1 },
        },
      });
      if (!moved.count) return [] as string[];
      const updated = await tx.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
      await cancelPendingJobs(tx, appointment.id);
      if (appointment.calUid) await markCalEvent(tx, appointment.calUid, 'CANCELLED', now);
      return publishAppointmentEvent(tx, updated, { type: 'appointment.cancelled' }, now, origin);
    });
    return { ok: true, alreadyCancelled: false, emailSent: await deliverNow(notifications) };
  });
}

/**
 * Mueve una cita a un horario nuevo como reserva provisional: vuelve a «pendiente», sin técnico
 * y sin reserva en Cal.com hasta que un técnico la confirme. Si estaba en Cal.com, esa reserva
 * se cancela allí (después de guardar, y marcada para que su webhook no cancele la cita).
 */
async function moveToHold(
  appointment: Appointment,
  start: Date,
  options: {
    deadline: Date;
    origin?: RequestOrigin | null;
    adminId?: string;
    /** Clientes: máximo MAX_RESCHEDULES (comprobado en la misma actualización). */
    limited: boolean;
  },
) {
  const now = new Date();
  const end = new Date(start.getTime() + (await calEventLengthMinutes()) * 60000);
  await assertSlotFree(start, end, appointment.id);
  const previousUid = appointment.calUid;
  const notifications = await db.$transaction(async (tx) => {
    await calLock(tx);
    await lockAppointment(tx, appointment.id);
    if ((await heldAppointments(tx, start, end, appointment.id)).length) throw slotTaken();
    await cancelPendingJobs(tx, appointment.id);
    // Contador y horario en una sola actualización condicionada: sin carreras.
    const moved = await tx.appointment.updateMany({
      where: {
        id: appointment.id,
        status: { in: ['PENDING_LOCATION', 'CONFIRMED'] },
        ...(options.limited ? { rescheduleCount: { lt: MAX_RESCHEDULES } } : {}),
      },
      data: {
        source: 'INSTAFIX_API',
        calUid: null,
        calStatus: null,
        startsAt: start,
        endsAt: end,
        rescheduleCount: { increment: 1 },
        automationRevision: { increment: 1 },
        ...unassignedForReschedule,
        holdStartedAt: now,
        holdExpiresAt: options.deadline,
        locationRequestedAt: now,
      },
    });
    if (!moved.count) {
      const current = await tx.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
      if (options.limited && current.rescheduleCount >= MAX_RESCHEDULES)
        throw coded(BadRequestException, 'RESCHEDULE_LIMIT', rescheduleLimitMessage);
      throw new BadRequestException('Esta cita ya no puede modificarse.');
    }
    const updated = await tx.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
    // El webhook de la cancelación de la reserva vieja no debe cancelar esta cita.
    if (previousUid) await markCalEvent(tx, previousUid, 'CANCELLED', now);
    if (options.adminId)
      await tx.adminAction.create({
        data: {
          actorId: options.adminId,
          action: 'APPOINTMENT_RESCHEDULED',
          target: appointment.id,
          detail: {
            from: appointment.startsAt.toISOString(),
            to: start.toISOString(),
            keptTechnician: false,
          },
        },
      });
    if (appointment.assignedTechnicianId)
      await tx.appointmentActivity.create({
        data: {
          appointmentId: appointment.id,
          actorId: options.adminId ?? null,
          action: 'UNASSIGNED_BY_RESCHEDULE',
          detail: { previousTechnicianId: appointment.assignedTechnicianId },
        },
      });
    if (!updated.locationReceivedAt && updated.whatsappConsentAt)
      await queueJob(tx, updated, 'INITIAL', now, updated.startsAt, options.origin);
    return publishAppointmentEvent(
      tx,
      updated,
      { type: 'appointment.rescheduled', previousStartsAt: appointment.startsAt },
      now,
      options.origin,
    );
  });
  if (previousUid) await releaseCalBooking(appointment.id, previousUid, 'Reprogramada en Instafix');
  return notifications;
}

/**
 * Reprogramación del cliente: la cita vuelve a reserva provisional en el horario nuevo (un
 * técnico debe confirmarla otra vez). Máximo MAX_RESCHEDULES por cita.
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
    const deadline = holdDeadline(new Date(), start);
    if (!deadline) throw slotTooSoon();
    const notifications = await moveToHold(appointment, start, {
      deadline,
      origin,
      limited: true,
    });
    return {
      ok: true,
      startsAt: start.toISOString(),
      emailSent: await deliverNow(notifications),
      unchanged: false,
    };
  });
}

/**
 * Reprogramación hecha por administración. Conservando al técnico de una cita confirmada, se
 * mueve la reserva en Cal.com y sigue confirmada. Si no, la cita vuelve a reserva provisional
 * (sale de Cal.com) para que un técnico la tome. Sin límite de cambios; admite el mismo día.
 */
export async function adminRescheduleBooking(
  adminId: string,
  id: string,
  startValue: string,
  keepTechnician: boolean,
) {
  const start = new Date(startValue);
  return exclusive(`appointment:${id}`, async () => {
    const appointment = await db.appointment.findFirst({ where: { id, deletedAt: null } });
    if (!appointment || !['PENDING_LOCATION', 'CONFIRMED'].includes(appointment.status))
      throw new BadRequestException(
        'Solo se puede cambiar la fecha de una cita pendiente o confirmada.',
      );
    if (!usesHold(appointment))
      throw new BadRequestException(
        'Esta cita no está en la agenda: cambia la fecha en el formulario y guarda.',
      );
    if (appointment.startsAt.getTime() === start.getTime())
      return {
        ok: true,
        startsAt: appointment.startsAt.toISOString(),
        unchanged: true,
        kept: false,
      };
    if (start.getTime() < Date.now() + 5 * 60000)
      throw new BadRequestException('Elige una fecha y hora futuras.');
    // Se conserva al técnico solo si la cita ya estaba confirmada con uno (y en Cal.com).
    const kept =
      keepTechnician &&
      appointment.status === 'CONFIRMED' &&
      !!appointment.assignedTechnicianId &&
      !!appointment.calUid;
    if (!kept) {
      const notifications = await moveToHold(appointment, start, {
        deadline: holdDeadlineForExisting(new Date(), start),
        adminId,
        limited: false,
      });
      await deliverNow(notifications);
      logEvent('booking.admin_rescheduled', {
        appointmentId: appointment.id,
        keptTechnician: false,
      });
      return { ok: true, startsAt: start.toISOString(), unchanged: false, kept: false };
    }
    const calUid = appointment.calUid!;
    let booking: CalBooking;
    try {
      booking = await rescheduleCalBooking(calUid, start, 'Reprogramada por Instafix');
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
      const updated = await tx.appointment.update({
        where: { id: appointment.id },
        data: {
          calUid: booking.uid,
          calStatus: booking.status,
          startsAt: booking.start,
          endsAt: booking.end,
          rescheduleCount: { increment: 1 },
          automationRevision: { increment: 1 },
        },
      });
      await markCalEvent(tx, calUid, 'CANCELLED', now);
      await markCalEvent(tx, booking.uid, 'RESCHEDULED_BY_API', now);
      await tx.adminAction.create({
        data: {
          actorId: adminId,
          action: 'APPOINTMENT_RESCHEDULED',
          target: appointment.id,
          detail: {
            from: appointment.startsAt.toISOString(),
            to: booking.start.toISOString(),
            keptTechnician: true,
          },
        },
      });
      // El recordatorio del día anterior y los de «completar trabajo» van a la fecha nueva.
      await queueReminders(tx, updated, now);
      await scheduleCompletionReminders(tx, updated, now);
      return publishAppointmentEvent(
        tx,
        updated,
        { type: 'appointment.rescheduled', previousStartsAt: appointment.startsAt },
        now,
      );
    });
    await deliverNow(notifications);
    logEvent('booking.admin_rescheduled', { appointmentId: appointment.id, keptTechnician: true });
    return { ok: true, startsAt: booking.start.toISOString(), unchanged: false, kept: true };
  });
}
