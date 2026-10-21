import { recordCompletedJob } from '../jobs/completed-job';
import type { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { lockAppointment } from '../whatsapp/queue';

/** Antigüedad máxima: un número reasignado no hereda reservas antiguas de otra persona. */
export const GUEST_CLAIM_DAYS = 180;

/**
 * Asocia reservas de invitado al usuario que ACABA de demostrar con OTP que controla ese
 * teléfono. Nunca se llama antes de la verificación ni con un teléfono sin verificar.
 */
export async function claimGuestAppointments(
  tx: Prisma.TransactionClient,
  userId: string,
  verifiedPhone: string,
  now = new Date(),
) {
  const candidates = await tx.appointment.findMany({
    where: {
      userId: null,
      deletedAt: null,
      contactPhone: verifiedPhone,
      bookingIdentityIssue: null,
      createdAt: { gte: new Date(now.getTime() - GUEST_CLAIM_DAYS * 86400000) },
    },
    select: { id: true },
  });
  let claimed = 0;
  for (const { id } of candidates) {
    await lockAppointment(tx, id);
    const updated = await tx.appointment.updateMany({
      where: { id, userId: null, contactPhone: verifiedPhone, bookingIdentityIssue: null },
      data: { userId },
    });
    if (!updated.count) continue;
    claimed++;
    await recordCompletedJob(tx, id);
    await tx.integrationEvent.create({
      data: {
        id: `account-link:${randomUUID()}`,
        provider: 'ACCOUNT_LINK',
        sourceId: id,
        occurredAt: now,
        outcome: `PHONE_OTP:${userId}`,
      },
    });
  }
  return claimed;
}
