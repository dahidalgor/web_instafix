import { BadRequestException, NotFoundException } from '@nestjs/common';
import { bookingTimeZone, type BookingCreateInput, type MyAppointment } from '@instafix/contracts';
import { normalizePhone } from '@instafix/contracts/src/phone';
import { Prisma, type Appointment } from '@prisma/client';
import { emitAppointmentEvent } from '../appointments/appointment-events';
import { db } from '../database/client';
import {
  appointmentStatusFromCal,
  CalApiError,
  cancelCalBooking,
  createCalBooking,
  findCalBookingForAppointment,
  getCalSlots,
  localDate,
  rescheduleCalBooking,
  type CalBooking,
} from '../integrations/cal-api';
import { cancelPendingJobs, lockAppointment } from '../whatsapp/queue';
import { bookingError } from './booking-errors';

export const BOOKING_TIME_ZONE = process.env.CAL_TIME_ZONE || bookingTimeZone;
// Cancelar o reprogramar desde la web exige este margen antes del inicio.
export const MIN_CHANGE_NOTICE_MS = 2 * 60 * 60 * 1000;
// Campo del evento de Cal.com que recibe la solicitud del cliente.
const CAL_REQUEST_FIELD = process.env.CAL_REQUEST_FIELD || 'notes';
// Una creación que sigue en CREATING después de este tiempo se concilia con Cal.com.
const STALE_CREATING_MS = 2 * 60 * 1000;

export type BookingUser = { id: string; name: string; phone: string; email: string | null };

// ---------------------------------------------------------------- Disponibilidad

const cache = new Map<
  string,
  { expires: number; days: Record<string, { start: string; end: string }[]> }
>();

export async function availability(input: {
  start: string;
  end: string;
  rescheduleUid?: string;
  fresh?: boolean;
}) {
  const today = localDate(new Date(), BOOKING_TIME_ZONE);
  const start = input.start < today ? today : input.start;
  if (input.end < start) return {};
  const span = (Date.parse(input.end) - Date.parse(start)) / 86400000;
  if (span > 62) throw new BadRequestException('Consulta como máximo dos meses');
  const key = `${start}|${input.end}|${input.rescheduleUid ?? ''}`;
  const hit = cache.get(key);
  if (!input.fresh && hit && hit.expires > Date.now()) return hit.days;
  try {
    const days = await getCalSlots({
      startDate: start,
      endDate: input.end,
      timeZone: BOOKING_TIME_ZONE,
      bookingUidToReschedule: input.rescheduleUid,
    });
    // Nunca se ofrece un horario que ya empezó.
    const now = Date.now();
    for (const [day, slots] of Object.entries(days)) {
      days[day] = slots.filter((slot) => Date.parse(slot.start) > now);
      if (!days[day].length) delete days[day];
    }
    cache.set(key, { expires: Date.now() + 30000, days });
    if (cache.size > 200) cache.delete(cache.keys().next().value!);
    return days;
  } catch (error) {
    if (error instanceof CalApiError && error.kind === 'NOT_CONFIGURED')
      throw bookingError('NOT_CONFIGURED');
    throw bookingError('PROVIDER_UNAVAILABLE');
  }
}

/** Revalida contra Cal.com que el inicio elegido sigue libre en este momento. */
async function slotStillAvailable(start: Date, rescheduleUid?: string) {
  const day = localDate(start, BOOKING_TIME_ZONE);
  const days = await availability({ start: day, end: day, rescheduleUid, fresh: true });
  return (days[day] ?? []).find((slot) => Date.parse(slot.start) === start.getTime()) ?? null;
}

export function clearAvailabilityCache() {
  cache.clear();
}

// ---------------------------------------------------------------- Vista del cliente

type AppointmentWithRelations = Appointment & {
  offering?: { title: string; device: string } | null;
  rescheduledTo?: { id: string } | null;
};

export function canChange(appointment: Appointment, now = Date.now()) {
  return (
    Boolean(appointment.calUid) &&
    ['PENDING_LOCATION', 'CONFIRMED'].includes(appointment.status) &&
    appointment.startsAt.getTime() - now > MIN_CHANGE_NOTICE_MS
  );
}

export function toMyAppointment(
  appointment: AppointmentWithRelations,
  now = Date.now(),
): MyAppointment {
  const changeable = canChange(appointment, now);
  return {
    id: appointment.id,
    status: appointment.status,
    startsAt: appointment.startsAt.toISOString(),
    endsAt: appointment.endsAt.toISOString(),
    timeZone: appointment.timeZone,
    device: appointment.device,
    customerRequest: appointment.customerRequest || appointment.title,
    assignedService: appointment.offering ?? null,
    technician: appointment.technician,
    needsReview: Boolean(appointment.bookingIdentityIssue),
    canCancel: changeable,
    canReschedule: changeable,
    rescheduledToId: appointment.rescheduledTo?.id ?? null,
    cancellationReason: appointment.cancellationReason,
  };
}

const viewInclude = {
  offering: { select: { title: true, device: true } },
  rescheduledTo: { select: { id: true } },
} as const;

/** Próximas (la más cercana primero) e historial (la más reciente primero), solo del usuario. */
export async function myAppointments(userId: string, now = new Date()) {
  const appointments = await db.appointment.findMany({
    where: { userId, status: { not: 'FAILED' } },
    include: viewInclude,
  });
  const active = ['CREATING', 'PENDING_LOCATION', 'CONFIRMED', 'IN_PROGRESS'];
  const upcoming = appointments
    .filter((a) => active.includes(a.status) && a.endsAt > now)
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  const history = appointments
    .filter((a) => !upcoming.includes(a))
    .sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime());
  return {
    upcoming: upcoming.map((a) => toMyAppointment(a, now.getTime())),
    history: history.map((a) => toMyAppointment(a, now.getTime())),
  };
}

/** 404 tanto si no existe como si pertenece a otra persona: no se revela su existencia. */
export async function ownedAppointment(userId: string, id: string) {
  const appointment = await db.appointment.findFirst({
    where: { id, userId },
    include: viewInclude,
  });
  if (!appointment) throw new NotFoundException('Cita no encontrada');
  return appointment;
}

// ---------------------------------------------------------------- Contacto

/**
 * Con sesión, los datos salen siempre de PostgreSQL y lo enviado por el navegador se ignora.
 * Un invitado no puede usar el WhatsApp de una cuenta existente.
 */
export async function resolveContact(input: BookingCreateInput, user: BookingUser | null) {
  if (user) {
    const account = await db.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { id: true, name: true, phone: true, email: true },
    });
    const phone = normalizePhone(account.phone, 'EC');
    if (!phone)
      throw new BadRequestException('El teléfono de tu cuenta no es válido. Contáctanos.');
    if (!account.email)
      throw new BadRequestException('Tu cuenta necesita un correo verificado para reservar.');
    return { userId: account.id, name: account.name, phone, email: account.email };
  }
  if (!input.guest) throw new BadRequestException('Completa tus datos de contacto.');
  const phone = normalizePhone(input.guest.phone, 'EC');
  if (!phone) throw new BadRequestException('Revisa tu número de WhatsApp y el país seleccionado.');
  const owner = await db.user.findUnique({ where: { phone }, select: { id: true } });
  if (owner) throw bookingError('ACCOUNT_EXISTS');
  return {
    userId: null,
    name: `${input.guest.firstName} ${input.guest.lastName}`,
    phone,
    email: input.guest.email,
  };
}

// ---------------------------------------------------------------- Creación

function sameOwner(appointment: Appointment, userId: string | null) {
  return appointment.userId === userId;
}

/** Aplica la respuesta de Cal.com a la cita y registra el evento de dominio una sola vez. */
async function applyCreatedBooking(id: string, booking: CalBooking) {
  return db.$transaction(async (tx) => {
    await lockAppointment(tx, id);
    const current = await tx.appointment.findUniqueOrThrow({ where: { id } });
    if (current.calUid && current.calUid !== booking.uid)
      throw new Error('La cita ya está vinculada a otra reserva');
    const wasCreating = ['CREATING', 'FAILED'].includes(current.status);
    const status = wasCreating ? appointmentStatusFromCal(booking.status) : current.status;
    const updated = await tx.appointment.update({
      where: { id },
      data: {
        calUid: booking.uid,
        calStatus: booking.status,
        status,
        startsAt: new Date(booking.start),
        endsAt: new Date(booking.end),
        bookingError: null,
        calSyncedAt: new Date(),
      },
      include: viewInclude,
    });
    if (status === 'CANCELLED') return updated;
    await emitAppointmentEvent(tx, updated, 'appointment.created');
    if (status === 'CONFIRMED') await emitAppointmentEvent(tx, updated, 'appointment.confirmed');
    return updated;
  });
}

async function markFailed(id: string, code: string) {
  await db.appointment.updateMany({
    where: { id, status: 'CREATING' },
    data: { status: 'FAILED', bookingError: code },
  });
}

/** Busca en Cal.com una reserva creada para esta cita cuya respuesta no recibimos. */
async function reconcile(appointment: Appointment) {
  try {
    const booking = await findCalBookingForAppointment({
      appointmentId: appointment.id,
      start: appointment.startsAt,
      attendeeEmail: appointment.contactEmail,
    });
    if (booking) return applyCreatedBooking(appointment.id, booking);
  } catch {
    throw bookingError('UNCERTAIN');
  }
  return null;
}

/** Repite una solicitud con la misma clave: devuelve el resultado ya conocido, nunca duplica. */
async function replay(existing: Appointment, userId: string | null) {
  if (!sameOwner(existing, userId)) throw bookingError('REJECTED');
  if (existing.status === 'FAILED') {
    if (existing.bookingError === 'SLOT_TAKEN') throw bookingError('SLOT_TAKEN');
    if (existing.bookingError === 'PROVIDER_UNAVAILABLE')
      throw bookingError('PROVIDER_UNAVAILABLE');
    if (existing.bookingError === 'INVALID_EMAIL') throw bookingError('INVALID_EMAIL');
    throw bookingError('REJECTED');
  }
  if (existing.status === 'CREATING') {
    if (
      Date.now() - existing.createdAt.getTime() < STALE_CREATING_MS &&
      existing.bookingError !== 'UNCERTAIN'
    )
      throw bookingError('IN_PROGRESS');
    const linked = await reconcile(existing);
    if (linked) return linked;
    // Cal.com no tiene una reserva para esta cita: se puede intentar de nuevo con otra clave.
    await markFailed(existing.id, 'UNCERTAIN_NOT_FOUND');
    throw bookingError('UNCERTAIN');
  }
  return db.appointment.findUniqueOrThrow({ where: { id: existing.id }, include: viewInclude });
}

export async function createBooking(input: BookingCreateInput, user: BookingUser | null) {
  const contact = await resolveContact(input, user);
  const start = new Date(input.start);
  if (start.getTime() <= Date.now()) throw bookingError('SLOT_TAKEN');

  const previous = await db.appointment.findUnique({ where: { bookingKey: input.requestKey } });
  if (previous) return replay(previous, contact.userId);

  // La disponibilidad mostrada puede estar desactualizada: se revalida antes de crear.
  const slot = await slotStillAvailable(start);
  if (!slot) throw bookingError('SLOT_TAKEN');

  let appointment: Appointment;
  try {
    appointment = await db.appointment.create({
      data: {
        userId: contact.userId,
        contactName: contact.name,
        contactPhone: contact.phone,
        contactEmail: contact.email,
        customerRequest: input.customerRequest,
        title: input.customerRequest.slice(0, 150),
        // Equipo y servicio los registra el técnico (Administración → Citas).
        device: 'Por especificar',
        startsAt: start,
        endsAt: new Date(slot.end),
        timeZone: BOOKING_TIME_ZONE,
        address: '',
        technician: '',
        status: 'CREATING',
        source: 'INSTAFIX',
        bookingKey: input.requestKey,
        whatsappConsentAt: new Date(),
      },
    });
  } catch (error) {
    // Doble clic o reintento simultáneo con la misma clave: solo una fila llega a crearse.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const existing = await db.appointment.findUnique({ where: { bookingKey: input.requestKey } });
      if (existing) return replay(existing, contact.userId);
    }
    throw error;
  }

  let booking: CalBooking;
  try {
    booking = await createCalBooking({
      start: start.toISOString(),
      attendee: {
        name: contact.name,
        email: contact.email,
        phoneNumber: contact.phone,
        timeZone: BOOKING_TIME_ZONE,
      },
      // El evento real pide la descripción en «notes» («¿Qué trabajo requiere?»).
      // El consentimiento de WhatsApp se conserva en PostgreSQL (whatsappConsentAt).
      bookingFieldsResponses: {
        [CAL_REQUEST_FIELD]: input.customerRequest.slice(0, 1000),
      },
      metadata: { instafixAppointmentId: appointment.id, instafixSource: 'web' },
    });
  } catch (error) {
    if (error instanceof CalApiError && error.kind === 'UNCERTAIN') {
      await db.appointment.update({
        where: { id: appointment.id },
        data: { bookingError: 'UNCERTAIN' },
      });
      throw bookingError('UNCERTAIN');
    }
    if (error instanceof CalApiError && error.kind === 'REJECTED') {
      // Cal.com rechazó: si el horario ya no figura libre, alguien lo tomó mientras tanto.
      // Cal.com valida que el correo pueda recibir mensajes (dominio con MX).
      if (/email/i.test(error.message) && /(valid|receive)/i.test(error.message)) {
        await markFailed(appointment.id, 'INVALID_EMAIL');
        throw bookingError('INVALID_EMAIL');
      }
      const stillFree = await slotStillAvailable(start).catch(() => null);
      const code = stillFree ? 'REJECTED' : 'SLOT_TAKEN';
      await markFailed(appointment.id, stillFree ? `REJECTED: ${error.message}` : code);
      if (stillFree)
        console.error(`Reserva rechazada por Cal.com (${appointment.id}): ${error.message}`);
      throw bookingError(code);
    }
    await markFailed(appointment.id, 'PROVIDER_UNAVAILABLE');
    throw bookingError('PROVIDER_UNAVAILABLE');
  }

  try {
    return await applyCreatedBooking(appointment.id, booking);
  } catch (error) {
    // La reserva existe en Cal.com. El webhook o el siguiente reintento (misma clave) la vinculan.
    console.error(`Reserva ${booking.uid} creada sin vincular (${appointment.id})`);
    await db.appointment
      .update({ where: { id: appointment.id }, data: { bookingError: 'UNCERTAIN' } })
      .catch(() => undefined);
    throw bookingError('UNCERTAIN');
  }
}

// ---------------------------------------------------------------- Cancelación y reprogramación

export async function cancelBooking(userId: string, id: string, reason?: string) {
  const appointment = await ownedAppointment(userId, id);
  if (appointment.status === 'CANCELLED') return appointment;
  if (!canChange(appointment)) throw bookingError('NOT_ALLOWED');
  const cancellationReason = reason?.trim() || 'Cancelada por el cliente desde InstaFix';
  try {
    await cancelCalBooking(appointment.calUid!, cancellationReason);
  } catch (error) {
    if (error instanceof CalApiError && error.kind === 'REJECTED')
      throw bookingError('NOT_ALLOWED');
    if (error instanceof CalApiError && error.kind === 'UNCERTAIN') throw bookingError('UNCERTAIN');
    throw bookingError('PROVIDER_UNAVAILABLE');
  }
  clearAvailabilityCache();
  return db.$transaction(async (tx) => {
    await lockAppointment(tx, id);
    const current = await tx.appointment.findUniqueOrThrow({ where: { id } });
    if (current.status === 'CANCELLED')
      return tx.appointment.findUniqueOrThrow({ where: { id }, include: viewInclude });
    const updated = await tx.appointment.update({
      where: { id },
      data: {
        status: 'CANCELLED',
        calStatus: 'cancelled',
        cancellationReason,
        automationRevision: { increment: 1 },
        calSyncedAt: new Date(),
      },
      include: viewInclude,
    });
    await cancelPendingJobs(tx, id);
    await emitAppointmentEvent(tx, updated, 'appointment.cancelled');
    return updated;
  });
}

/** Crea la cita sustituta y marca la anterior como RESCHEDULED (dentro de una transacción). */
export async function applyRescheduleTx(
  tx: Prisma.TransactionClient,
  oldId: string,
  booking: CalBooking,
  requestKey: string | null,
) {
  await lockAppointment(tx, oldId);
  const old = await tx.appointment.findUniqueOrThrow({
    where: { id: oldId },
    include: { rescheduledTo: true },
  });
  const existing =
    old.rescheduledTo ?? (await tx.appointment.findUnique({ where: { calUid: booking.uid } }));
  if (existing)
    return tx.appointment.findUniqueOrThrow({ where: { id: existing.id }, include: viewInclude });
  await tx.appointment.update({
    where: { id: oldId },
    data: {
      status: 'RESCHEDULED',
      calStatus: 'rescheduled',
      automationRevision: { increment: 1 },
      calSyncedAt: new Date(),
    },
  });
  await cancelPendingJobs(tx, oldId);
  const created = await tx.appointment.create({
    data: {
      userId: old.userId,
      contactName: old.contactName,
      contactPhone: old.contactPhone,
      contactEmail: old.contactEmail,
      customerRequest: old.customerRequest,
      title: old.title,
      device: old.device,
      offeringId: old.offeringId,
      address: old.address,
      technician: old.technician,
      timeZone: old.timeZone,
      whatsappConsentAt: old.whatsappConsentAt,
      bookingIdentityIssue: old.bookingIdentityIssue,
      source: old.source,
      bookingKey: requestKey,
      calUid: booking.uid,
      calStatus: booking.status,
      status: appointmentStatusFromCal(booking.status),
      startsAt: new Date(booking.start),
      endsAt: new Date(booking.end),
      rescheduledFromId: old.id,
      calSyncedAt: new Date(),
    },
    include: viewInclude,
  });
  await emitAppointmentEvent(tx, created, 'appointment.rescheduled', {
    previousStartsAt: old.startsAt.toISOString(),
    previousAppointmentId: old.id,
  });
  return created;
}

export function applyReschedule(oldId: string, booking: CalBooking, requestKey: string | null) {
  return db.$transaction((tx) => applyRescheduleTx(tx, oldId, booking, requestKey));
}

export async function rescheduleBooking(
  userId: string,
  id: string,
  input: { requestKey: string; start: string },
) {
  const repeated = await db.appointment.findUnique({
    where: { bookingKey: input.requestKey },
    include: viewInclude,
  });
  if (repeated) {
    if (repeated.userId !== userId) throw bookingError('REJECTED');
    return repeated;
  }
  const appointment = await ownedAppointment(userId, id);
  if (!canChange(appointment)) throw bookingError('NOT_ALLOWED');
  const start = new Date(input.start);
  if (start.getTime() === appointment.startsAt.getTime())
    throw new BadRequestException('Elige un horario diferente al actual.');
  if (!(await slotStillAvailable(start, appointment.calUid!))) throw bookingError('SLOT_TAKEN');
  let booking: CalBooking;
  try {
    booking = await rescheduleCalBooking(
      appointment.calUid!,
      start.toISOString(),
      'Reprogramada por el cliente desde InstaFix',
    );
  } catch (error) {
    if (error instanceof CalApiError && error.kind === 'REJECTED') {
      const stillFree = await slotStillAvailable(start, appointment.calUid!).catch(() => null);
      throw bookingError(stillFree ? 'REJECTED' : 'SLOT_TAKEN');
    }
    if (error instanceof CalApiError && error.kind === 'UNCERTAIN') throw bookingError('UNCERTAIN');
    throw bookingError('PROVIDER_UNAVAILABLE');
  }
  clearAvailabilityCache();
  return applyReschedule(appointment.id, booking, input.requestKey);
}
