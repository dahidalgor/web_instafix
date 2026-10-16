import type { Appointment, Prisma } from '@prisma/client';
import { reminderTimes } from './messages';

export async function queueJob(
  tx: Prisma.TransactionClient,
  appointment: Appointment,
  kind: string,
  dueAt: Date,
  expiresAt = appointment.startsAt,
) {
  if (expiresAt <= dueAt) return;
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
    },
  });
}
export async function queueReminders(
  tx: Prisma.TransactionClient,
  appointment: Appointment,
  now = new Date(),
) {
  if (
    !appointment.whatsappConsentAt ||
    !appointment.contactPhone ||
    appointment.status !== 'CONFIRMED'
  )
    return;
  const times = reminderTimes(appointment.startsAt);
  if (now < times.dayStart)
    await queueJob(
      tx,
      appointment,
      'DAY_BEFORE',
      new Date(Math.max(now.getTime(), times.dayBefore.getTime())),
      times.dayStart,
    );
  await queueJob(
    tx,
    appointment,
    'SAME_DAY',
    new Date(Math.max(now.getTime(), times.sameDay.getTime())),
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
