import type { Prisma } from '@prisma/client';
import { db } from '../database/client';
import { lockAppointment } from '../whatsapp/queue';

const dateEc = (instant: Date) =>
  new Intl.DateTimeFormat('es-EC', {
    timeZone: 'America/Guayaquil',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(instant);

/**
 * Trabajo realizado para la cuenta del cliente a partir de una cita completada en el panel
 * técnico: servicios, importe y garantía según los días del catálogo al registrarlos. Idempotente
 * (un trabajo por cita); sin cuenta de cliente no hace nada (se crea al vincular la cita).
 * Debe llamarse con la cita bloqueada (lockAppointment).
 */
export async function recordCompletedJob(tx: Prisma.TransactionClient, appointmentId: string) {
  const a = await tx.appointment.findUnique({
    where: { id: appointmentId },
    include: { services: { orderBy: { createdAt: 'asc' } }, completedJob: true },
  });
  if (!a || a.status !== 'COMPLETED' || !a.userId || a.completedJob) return null;
  const services = a.services;
  const completedAt = a.completedAt ?? new Date();
  const days = Math.max(0, ...services.map((s) => s.warrantyDaysSnapshot));
  const warrantyEndsAt = days > 0 ? new Date(completedAt.getTime() + days * 86400000) : null;
  const title = services.length
    ? services
        .map((s) => (s.quantity > 1 ? `${s.nameSnapshot} ×${s.quantity}` : s.nameSnapshot))
        .join(' + ')
    : a.title;
  return tx.completedJob.create({
    data: {
      userId: a.userId,
      appointmentId: a.id,
      offeringId: services.find((s) => s.offeringId)?.offeringId ?? a.offeringId ?? null,
      title: title.slice(0, 200),
      device: (services[0]?.deviceSnapshot || a.device || 'Equipo').slice(0, 120),
      priceMinor: services.reduce((total, s) => total + s.totalMinor, 0),
      giveawayEntries: a.giveawayEntries,
      currency: services[0]?.currency || 'USD',
      completedAt,
      warrantyEndsAt,
      warrantyTerms: warrantyEndsAt
        ? `Garantía de ${days} días por el servicio realizado, hasta el ${dateEc(warrantyEndsAt)}. Aplican las políticas de garantía de Instafix.`
        : 'Este servicio no incluye garantía.',
    },
  });
}

/** Citas completadas de una cuenta que aún no tienen trabajo registrado (p. ej. anteriores). */
export async function recordMissingCompletedJobs(userId: string) {
  const pending = await db.appointment.findMany({
    where: { userId, status: 'COMPLETED', completedJob: null },
    select: { id: true },
    take: 50,
  });
  for (const { id } of pending)
    await db.$transaction(async (tx) => {
      await lockAppointment(tx, id);
      await recordCompletedJob(tx, id);
    });
}
