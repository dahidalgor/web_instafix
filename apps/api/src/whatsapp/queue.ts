import type { Appointment, Prisma } from '@prisma/client';
import type { RequestOrigin } from '../security/client-identity';
import { reminderTimes } from './messages';

/**
 * Encola un aviso (outbox): se guarda en la misma transacción que el cambio de la cita y lo
 * envía el worker, que antes comprueba el presupuesto. `origin` = quien lo provocó; los avisos
 * del equipo o del sistema heredan la sesión/IP que creó la cita.
 */
export async function queueJob(
  tx: Prisma.TransactionClient,
  appointment: Appointment,
  kind: string,
  dueAt: Date,
  expiresAt = appointment.startsAt,
  origin?: RequestOrigin | null,
) {
  if (appointment.bookingIdentityIssue || appointment.deletedAt || expiresAt <= dueAt) return;
  const dedupeKey = `${appointment.id}:${appointment.automationRevision}:${kind}`;
  await tx.automationJob.upsert({
    where: { dedupeKey },
    update: {},
    create: {
      dedupeKey,
      appointmentId: appointment.id,
      revision: appointment.automationRevision,
      kind,
      dueAt,
      expiresAt,
      recipient: appointment.contactPhone || null,
      originSessionKey: origin?.sessionKey ?? appointment.originSessionKey,
      originIpHash: origin?.ipHash ?? appointment.originIpHash,
    },
  });
}
export async function queueReminders(
  tx: Prisma.TransactionClient,
  appointment: Appointment,
  now = new Date(),
) {
  if (
    appointment.bookingIdentityIssue ||
    !appointment.whatsappConsentAt ||
    !appointment.contactPhone ||
    appointment.status !== 'CONFIRMED'
  )
    return;
  // Un único recordatorio: el día anterior a las 08:00 de Ecuador (o al confirmar, si ya pasó
  // esa hora). Caduca a las 00:00 del día de la visita: el mismo día nunca sale un «mañana».
  // No hay recordatorio del mismo día: la plantilla aprobada dice «mañana».
  const times = reminderTimes(appointment.startsAt);
  if (now < times.dayStart)
    await queueJob(
      tx,
      appointment,
      'DAY_BEFORE',
      new Date(Math.max(now.getTime(), times.dayBefore.getTime())),
      times.dayStart,
    );
}
export async function cancelPendingJobs(tx: Prisma.TransactionClient, id: string) {
  await tx.automationJob.updateMany({
    where: { appointmentId: id, status: { in: ['PENDING', 'RETRY'] } },
    data: { status: 'CANCELLED' },
  });
}
export async function lockAppointment(tx: Prisma.TransactionClient, id: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`appointment:${id}`}))`;
}
