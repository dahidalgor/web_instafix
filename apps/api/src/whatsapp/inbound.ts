import { normalizePhone } from '@instafix/contracts/src/phone';
import { db } from '../database/client';
import { lockAppointment } from './queue';

// Entrada normalizada: únicamente mensajes nuevos del cliente, nunca ecos ni historial.
export async function receiveCustomerMessage(message: {
  id: string;
  from: string;
  timestamp: string;
  type: string;
  context?: { id: string };
  /** Ubicación nativa de WhatsApp o sacada de un enlace de mapas (puede venir sin coordenadas). */
  location?: {
    latitude?: number;
    longitude?: number;
    name?: string;
    address?: string;
    url?: string;
  };
}) {
  const phone = normalizePhone(`+${message.from}`, 'EC');
  if (!phone) return null;
  const receivedAt = new Date(Number(message.timestamp) * 1000);
  if (!Number.isFinite(receivedAt.getTime()) || receivedAt.getTime() > Date.now() + 300000)
    return null;
  // Devuelve la cita que recibió la ubicación, para completar después su calle y sector.
  return db.$transaction(async (tx): Promise<string | null> => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`inbound:${phone}`}))`;
    const eventId = `wa:${message.id}`;
    if (await tx.integrationEvent.findUnique({ where: { id: eventId } })) return null;
    let outcome = 'IGNORED';
    let located: string | null = null;
    if (message.type === 'location' && message.location) {
      const candidates = await tx.appointment.findMany({
        where: {
          contactPhone: phone,
          bookingIdentityIssue: null,
          status: { in: ['PENDING_LOCATION', 'CONFIRMED'] },
          locationReceivedAt: null,
          whatsappConsentAt: { not: null },
          startsAt: { gt: new Date() },
          createdAt: { lte: new Date(receivedAt.getTime() + 1000) },
        },
        orderBy: { startsAt: 'asc' },
      });
      let candidate = candidates.length === 1 ? candidates[0] : undefined;
      if (message.context?.id) {
        const repliedTo = await tx.automationJob.findUnique({
          where: { providerMessageId: message.context.id },
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
          !current.bookingIdentityIssue &&
          ['PENDING_LOCATION', 'CONFIRMED'].includes(current.status) &&
          !current.locationReceivedAt &&
          current.automationRevision === candidate.automationRevision
        ) {
          const updated = await tx.appointment.update({
            where: { id: current.id },
            data: {
              locationLatitude: message.location.latitude ?? null,
              locationLongitude: message.location.longitude ?? null,
              // Con coordenadas basta el nombre; sin ellas se guarda el enlace para abrirlo.
              address:
                message.location.address ||
                (message.location.latitude !== undefined
                  ? message.location.name ||
                    `${message.location.latitude}, ${message.location.longitude}`
                  : [message.location.name, message.location.url].filter(Boolean).join(' · ') ||
                    'Ubicación enviada por WhatsApp'),
              locationReceivedAt: receivedAt,
              locationArea: null,
              automationIssue: null,
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
          // La ubicación solo informa al técnico; la confirmación la hace el técnico.
          outcome = 'LOCATION_ACCEPTED';
          located = updated.id;
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
    return located;
  });
}
