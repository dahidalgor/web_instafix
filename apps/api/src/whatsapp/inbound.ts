import { normalizePhone } from '@instafix/contracts/src/phone';
import { db } from '../database/client';
import { lockAppointment, queueJob, queueReminders } from './queue';

// Entrada normalizada: únicamente mensajes nuevos del cliente, nunca ecos ni historial.
export async function receiveCustomerMessage(message: {
  id: string;
  from: string;
  timestamp: string;
  type: string;
  context?: { id: string };
  location?: { latitude: number; longitude: number; name?: string; address?: string };
}) {
  const phone = normalizePhone(`+${message.from}`, 'EC');
  if (!phone) return;
  const receivedAt = new Date(Number(message.timestamp) * 1000);
  if (!Number.isFinite(receivedAt.getTime()) || receivedAt.getTime() > Date.now() + 300000) return;
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`inbound:${phone}`}))`;
    const eventId = `wa:${message.id}`;
    if (await tx.integrationEvent.findUnique({ where: { id: eventId } })) return;
    let outcome = 'IGNORED';
    if (message.type === 'location' && message.location) {
      const candidates = await tx.appointment.findMany({
        where: {
          contactPhone: phone,
          status: 'PENDING_LOCATION',
          whatsappConsentAt: { not: null },
          startsAt: { gt: new Date() },
          createdAt: { lte: new Date(receivedAt.getTime() + 1000) },
        },
        orderBy: { startsAt: 'asc' },
      });
      let candidate = candidates.length === 1 ? candidates[0] : undefined;
      if (message.context?.id) {
        const repliedTo = await tx.automationJob.findUnique({
          where: { providerId: message.context.id },
        });
        candidate = candidates.find(
          (a) => a.id === repliedTo?.appointmentId && a.automationRevision === repliedTo.revision,
        );
      }
      if (
        candidate &&
        receivedAt.getTime() + 1000 >= candidate.locationRequestedAt.getTime() &&
        !candidate.locationReceivedAt
      ) {
        await lockAppointment(tx, candidate.id);
        const current = await tx.appointment.findUniqueOrThrow({
          where: { id: candidate.id },
        });
        if (
          current.status === 'PENDING_LOCATION' &&
          !current.locationReceivedAt &&
          current.automationRevision === candidate.automationRevision
        ) {
          const updated = await tx.appointment.update({
            where: { id: current.id },
            data: {
              locationLatitude: message.location.latitude,
              locationLongitude: message.location.longitude,
              address:
                message.location.address ||
                message.location.name ||
                `${message.location.latitude}, ${message.location.longitude}`,
              locationReceivedAt: receivedAt,
              automationIssue: null,
              ...(!current.calUid ? { status: 'CONFIRMED' } : {}),
            },
          });
          await tx.automationJob.updateMany({
            where: {
              appointmentId: updated.id,
              kind: 'INITIAL',
              status: { in: ['PENDING', 'RETRY'] },
            },
            data: { status: 'CANCELLED' },
          });
          if (updated.calUid) await queueJob(tx, updated, 'CAL_CONFIRM', new Date());
          else {
            await queueJob(tx, updated, 'CONFIRMED', new Date());
            await queueReminders(tx, updated);
          }
          outcome = 'LOCATION_ACCEPTED';
        }
      } else if (candidates.length > 1) {
        // Nunca asignar una ubicación a una cita arbitraria si hay varias pendientes.
        await tx.appointment.updateMany({
          where: { id: { in: candidates.map((a) => a.id) } },
          data: {
            automationIssue:
              'Varias citas pendientes: pide al cliente responder con ubicación al mensaje de la cita correcta.',
          },
        });
        outcome = 'AMBIGUOUS_LOCATION';
      } else outcome = 'NO_MATCHING_APPOINTMENT';
    }
    await tx.integrationEvent.create({
      data: {
        id: eventId,
        provider: 'WHATSAPP',
        sourceId: phone,
        occurredAt: receivedAt,
        outcome,
      },
    });
  });
}
