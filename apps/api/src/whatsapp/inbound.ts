import type { Appointment, Prisma } from '@prisma/client';
import { logEvent } from '../common/log-event';
import { normalizePhone } from '@instafix/contracts/src/phone';
import { db } from '../database/client';
import { CONSUMED } from './budget';
import { lockAppointment } from './queue';

/** Estados en los que una cita sigue esperando o puede corregir la ubicación del cliente. */
export const LOCATION_STATUSES = ['PENDING_LOCATION', 'CONFIRMED', 'IN_PROGRESS'] as const;
/** Una cita sigue «activa» para la ubicación hasta 3 h después de su fin (visita en curso). */
export const LOCATION_GRACE_MS = 3 * 3600000;
/** Una ubicación nueva poco después de otra corrige la misma cita («perdón, es aquí»). */
export const CORRECTION_WINDOW_MS = 2 * 3600000;

export const validCoordinates = (latitude: unknown, longitude: unknown) =>
  typeof latitude === 'number' &&
  typeof longitude === 'number' &&
  Number.isFinite(latitude) &&
  Number.isFinite(longitude) &&
  latitude >= -90 &&
  latitude <= 90 &&
  longitude >= -180 &&
  longitude <= 180;

type Location = {
  latitude?: number;
  longitude?: number;
  name?: string;
  address?: string;
  url?: string;
};

/**
 * Cita a la que pertenece una ubicación, sin depender del último ni del siguiente mensaje:
 * cada mensaje se evalúa al llegar contra las citas activas del número. Orden determinista:
 *  1. Respuesta citando un aviso de una cita concreta → esa cita.
 *  2. Citas sin ubicación cuya solicitud de ubicación ya se envió por WhatsApp: si es una sola.
 *  3. Citas sin ubicación: si es una sola.
 *  4. Todas tienen ubicación: corrección de la que recibió una ubicación en las últimas 2 h, o
 *     la única cita activa.
 * Con varias posibles se devuelve AMBIGUOUS: nunca se adivina.
 */
export async function locationTarget(
  tx: Prisma.TransactionClient,
  candidates: Appointment[],
  receivedAt: Date,
  repliedToMessageId?: string,
): Promise<Appointment | 'AMBIGUOUS' | null> {
  if (!candidates.length) return null;
  if (repliedToMessageId) {
    const job = await tx.automationJob.findUnique({
      where: { providerMessageId: repliedToMessageId },
    });
    const quoted = candidates.find((a) => a.id === job?.appointmentId);
    if (quoted) return quoted;
  }
  const waiting = candidates.filter((a) => !a.locationReceivedAt);
  if (waiting.length) {
    const requested = await tx.automationJob.findMany({
      where: {
        appointmentId: { in: waiting.map((a) => a.id) },
        kind: 'INITIAL',
        status: { in: CONSUMED },
      },
      select: { appointmentId: true, revision: true },
    });
    const asked = waiting.filter((a) =>
      requested.some((r) => r.appointmentId === a.id && r.revision === a.automationRevision),
    );
    if (asked.length === 1) return asked[0];
    if (waiting.length === 1) return waiting[0];
    return 'AMBIGUOUS';
  }
  const recent = candidates.filter(
    (a) =>
      a.locationReceivedAt &&
      a.locationReceivedAt.getTime() >= receivedAt.getTime() - CORRECTION_WINDOW_MS,
  );
  if (recent.length === 1) return recent[0];
  if (candidates.length === 1) return candidates[0];
  return 'AMBIGUOUS';
}

/**
 * Mensaje nuevo del cliente (nunca ecos ni historial). Solo un mensaje de tipo ubicación (o un
 * enlace de mapas con coordenadas) cambia la ubicación; un texto, emoji, imagen o sticker
 * posterior no la toca ni cancela la espera. Idempotente por id de mensaje.
 * Devuelve la cita que recibió la ubicación, para completar después su calle y sector.
 */
export async function receiveCustomerMessage(message: {
  id: string;
  from: string;
  timestamp: string;
  type: string;
  context?: { id: string };
  /** Ubicación nativa de WhatsApp o sacada de un enlace de mapas (puede venir sin coordenadas). */
  location?: Location;
}) {
  const phone = normalizePhone(`+${message.from}`, 'EC');
  if (!phone) return null;
  const receivedAt = new Date(Number(message.timestamp) * 1000);
  if (!Number.isFinite(receivedAt.getTime()) || receivedAt.getTime() > Date.now() + 300000)
    return null;
  return db.$transaction(async (tx): Promise<string | null> => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`inbound:${phone}`}))`;
    const eventId = `wa:${message.id}`;
    if (await tx.integrationEvent.findUnique({ where: { id: eventId } })) return null;
    let outcome = 'IGNORED';
    let located: string | null = null;
    const location = message.location;
    const hasCoordinates = location?.latitude !== undefined || location?.longitude !== undefined;
    if (
      message.type === 'location' &&
      location &&
      hasCoordinates &&
      !validCoordinates(location.latitude, location.longitude)
    ) {
      // Coordenadas fuera de rango: se rechazan sin tocar ninguna cita.
      outcome = 'INVALID_LOCATION';
      logEvent('whatsapp.location', { outcome }, 'warn');
    } else if (message.type === 'location' && location) {
      const candidates = await tx.appointment.findMany({
        where: {
          contactPhone: phone,
          deletedAt: null,
          bookingIdentityIssue: null,
          // Canceladas, completadas o pasadas nunca reciben ubicaciones nuevas.
          status: { in: [...LOCATION_STATUSES] },
          endsAt: { gt: new Date(receivedAt.getTime() - LOCATION_GRACE_MS) },
          createdAt: { lte: new Date(receivedAt.getTime() + 1000) },
        },
        orderBy: { startsAt: 'asc' },
      });
      const target = await locationTarget(tx, candidates, receivedAt, message.context?.id);
      if (target && target !== 'AMBIGUOUS') {
        await lockAppointment(tx, target.id);
        const current = await tx.appointment.findUniqueOrThrow({ where: { id: target.id } });
        if (
          !current.deletedAt &&
          (LOCATION_STATUSES as readonly string[]).includes(current.status) &&
          // Nunca se sustituye por una ubicación más antigua que la guardada.
          (!current.locationReceivedAt || current.locationReceivedAt <= receivedAt)
        ) {
          const coords = validCoordinates(location.latitude, location.longitude);
          const updated = await tx.appointment.update({
            where: { id: current.id },
            data: {
              locationLatitude: coords ? location.latitude : null,
              locationLongitude: coords ? location.longitude : null,
              // Con coordenadas, el nombre del lugar va aparte: la dirección escrita (si la
              // hay) se conserva. Sin coordenadas, el enlace se guarda en la dirección para abrirlo.
              locationName: coords
                ? [location.name, location.address].filter(Boolean).join(' · ').slice(0, 300) ||
                  null
                : null,
              ...(coords
                ? {}
                : {
                    address:
                      [location.name, location.url].filter(Boolean).join(' · ') ||
                      'Ubicación enviada por WhatsApp',
                  }),
              locationReceivedAt: receivedAt,
              locationSource: 'WHATSAPP',
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
          // La ubicación solo informa al técnico; no genera ningún WhatsApp de respuesta.
          outcome = current.locationReceivedAt ? 'LOCATION_UPDATED' : 'LOCATION_ACCEPTED';
          located = updated.id;
        } else outcome = 'STALE_LOCATION';
      } else if (target === 'AMBIGUOUS') {
        // Varias citas posibles: no se asigna a ninguna. El mensaje queda en el historial de
        // WhatsApp y el equipo ve la incidencia en las citas implicadas.
        await tx.appointment.updateMany({
          where: { id: { in: candidates.map((a) => a.id) } },
          data: {
            automationIssue:
              'Varias citas activas: el cliente envió una ubicación sin indicar a cuál corresponde. Pídele responder citando el mensaje de la cita o pégala desde el panel técnico.',
          },
        });
        outcome = 'AMBIGUOUS_LOCATION';
      } else outcome = 'NO_MATCHING_APPOINTMENT';
      logEvent(
        'whatsapp.location',
        { outcome, appointmentId: located, candidates: candidates.length },
        located ? 'info' : 'warn',
      );
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
