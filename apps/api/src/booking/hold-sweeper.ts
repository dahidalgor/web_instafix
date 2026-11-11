import { ConflictException } from '@nestjs/common';
import { logEvent } from '../common/log-event';
import { db } from '../database/client';
import { cancelCalBooking } from '../integrations/cal-client';
import { publishAppointmentEvent } from '../notifications/appointment-events';
import { exclusive } from '../security/idempotency';
import { cancelPendingJobs, lockAppointment } from '../whatsapp/queue';
import { markCalEvent } from './booking.service';
import { AUTO_CANCEL_REASONS, confirmDeadline, holdDeadlineForExisting } from './hold';

const waiting = {
  status: 'PENDING_LOCATION' as const,
  assignedTechnicianId: null,
  deletedAt: null,
};
/** Solo las citas de la agenda (web o Cal.com); las creadas a mano por administración no. */
const fromAgenda = [{ calUid: { not: null } }, { source: 'INSTAFIX_API' }];

/**
 * Barrido periódico (cada minuto, desde el worker de notificaciones):
 *  1. Las citas que esperan técnico y aún no tienen plazo reciben uno contando desde ahora
 *     (reservas directas en Cal.com, reprogramadas desde Cal.com y las anteriores a este cambio).
 *  2. Las vencidas se cancelan solas: el horario queda libre y el cliente recibe el aviso.
 */
export async function sweepBookingHolds(now = new Date()) {
  const missing = await db.appointment.findMany({
    where: { ...waiting, holdExpiresAt: null, endsAt: { gt: now }, OR: fromAgenda },
    select: { id: true, startsAt: true },
    take: 50,
  });
  for (const a of missing)
    await db.appointment.updateMany({
      where: { id: a.id, ...waiting, holdExpiresAt: null },
      data: { holdStartedAt: now, holdExpiresAt: holdDeadlineForExisting(now, a.startsAt) },
    });
  const due = await db.appointment.findMany({
    where: {
      ...waiting,
      OR: [
        { holdExpiresAt: { lte: now } },
        { responseDueAt: { lte: now }, locationReceivedAt: null },
      ],
    },
    select: { id: true },
    orderBy: { holdExpiresAt: 'asc' },
    take: 10,
  });
  const cancelled: string[] = [];
  for (const { id } of due) {
    try {
      if (await autoCancel(id, now)) cancelled.push(id);
    } catch (error) {
      // Otra operación sobre la misma cita (p. ej. un técnico confirmando): se reintenta luego.
      if (!(error instanceof ConflictException))
        logEvent(
          'booking.auto_cancel_failed',
          {
            appointmentId: id,
            reason: error instanceof Error ? error.message.slice(0, 200) : 'Error inesperado',
          },
          'warn',
        );
    }
  }
  return cancelled;
}

/** Cancela una cita cuyo plazo venció (comprobándolo otra vez). true si se canceló. */
export async function autoCancel(id: string, now = new Date()) {
  return exclusive(`appointment:${id}`, async () => {
    const a = await db.appointment.findUnique({ where: { id } });
    const deadline = a && confirmDeadline(a);
    if (!a || !deadline || deadline > now) return false;
    const noResponse =
      !a.locationReceivedAt &&
      a.responseDueAt !== null &&
      a.responseDueAt <= now &&
      (!a.holdExpiresAt || a.responseDueAt <= a.holdExpiresAt);
    const code = noResponse ? 'NO_RESPONSE' : 'NOT_CONFIRMED';
    if (a.calUid) {
      try {
        await cancelCalBooking(a.calUid, 'Cancelada automáticamente por Instafix: venció el plazo');
      } catch {
        // Cal.com no respondió: la cita sigue igual y se vuelve a intentar en 10 min.
        logEvent('booking.auto_cancel_cal_failed', { appointmentId: a.id }, 'warn');
        const retry = new Date(now.getTime() + 600000);
        await db.appointment.update({
          where: { id: a.id },
          data: noResponse ? { responseDueAt: retry } : { holdExpiresAt: retry },
        });
        return false;
      }
    }
    const done = await db.$transaction(async (tx) => {
      if (a.calUid) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('cal-webhooks'))`;
      await lockAppointment(tx, a.id);
      const moved = await tx.appointment.updateMany({
        where: { id: a.id, status: 'PENDING_LOCATION', assignedTechnicianId: null },
        data: {
          status: 'CANCELLED',
          calStatus: a.calUid ? 'cancelled' : null,
          autoCancelReason: AUTO_CANCEL_REASONS[code],
          automationRevision: { increment: 1 },
        },
      });
      if (!moved.count) return false;
      const updated = await tx.appointment.findUniqueOrThrow({ where: { id: a.id } });
      await cancelPendingJobs(tx, a.id);
      if (a.calUid) await markCalEvent(tx, a.calUid, 'CANCELLED', now);
      await tx.appointmentActivity.create({
        data: { appointmentId: a.id, action: 'AUTO_CANCELLED', detail: { reason: code } },
      });
      // Correo y WhatsApp «cita cancelada» (este último solo con autorización del cliente).
      await publishAppointmentEvent(tx, updated, { type: 'appointment.cancelled' }, now);
      return true;
    });
    if (done) logEvent('booking.auto_cancelled', { appointmentId: a.id, reason: code });
    return done;
  });
}
