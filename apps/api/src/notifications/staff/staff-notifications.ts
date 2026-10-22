import {
  appointmentPanelPath,
  appointmentRequestedMessage,
  type StaffNotificationType,
  type StaffPushPayload,
} from '@instafix/contracts';
import type { Appointment, Notification, Prisma, Role } from '@prisma/client';
import { logEvent } from '../../common/log-event';
import { db } from '../../database/client';
import type { StaffChannel } from './channels';
import { WebPushChannel } from './web-push.channel';

/**
 * Avisos al equipo (administración y técnicos).
 *
 *   hecho de negocio ──► reglas (quién, qué) ──► bandeja «Notification» ──► canal (Web Push…)
 *
 * - Las citas publican hechos en `publishAppointmentEvent`; este módulo no sabe nada de Cal.com.
 * - Cada aviso es una fila de la bandeja existente («Notification», channel = WEB_PUSH) por
 *   destinatario, creada en la MISMA transacción que la cita: solo existe si la cita quedó
 *   guardada, y la clave única (dedupeKey) impide duplicados entre la API, el webhook y los
 *   reintentos. El envío ocurre después, en NotificationWorker: un proveedor caído nunca
 *   deshace ni retrasa una cita.
 * - Contrato de la fila: kind = tipo de hecho, recipient = id del usuario destinatario,
 *   appointmentId = entidad, data = título/cuerpo/ruta, channel, status, lastError, createdAt.
 */

/** Quién puede recibir cada tipo de aviso. Hoy solo administración recibe solicitudes nuevas. */
export const staffRecipientRules: Record<StaffNotificationType, readonly Role[]> = {
  APPOINTMENT_REQUESTED: ['ADMIN'],
  // Preparados, sin productor todavía. Un aviso a un técnico concreto usaría
  // `recipientIds` (p. ej. el técnico asignado) en lugar de todo el rol.
  APPOINTMENT_CANCELLED: ['ADMIN'],
  APPOINTMENT_RESCHEDULED: ['ADMIN'],
  APPOINTMENT_ASSIGNED: ['TECHNICIAN'],
  // Prueba enviada por el propio usuario a sus dispositivos (POST /staff/push/test).
  TEST: ['ADMIN', 'TECHNICIAN'],
};

/** Tipos que hoy tienen un productor real (el resto está preparado en las reglas). */
export const producedStaffNotifications: readonly StaffNotificationType[] = [
  'APPOINTMENT_REQUESTED',
];

/** Roles que pueden registrar dispositivos para recibir avisos del equipo. */
export const pushRoles: readonly Role[] = ['ADMIN', 'TECHNICIAN'];

/** Un aviso que llega más tarde que esto ya no se envía (la cita ya se habrá atendido). */
const STALE_AFTER_MS = 24 * 3600 * 1000;
const MAX_ATTEMPTS = 5;

const channels: Record<string, StaffChannel> = { WEB_PUSH: new WebPushChannel() };
export const staffChannel = (name: string) => channels[name] ?? null;
export const configuredStaffChannels = () =>
  Object.values(channels)
    .filter((channel) => channel.configured())
    .map((channel) => channel.name);

export const staffNotificationKey = (
  type: StaffNotificationType,
  entityId: string,
  userId: string,
  channel = 'WEB_PUSH',
) => `${channel.toLowerCase()}:${type}:${entityId}:${userId}`;

/** Destinatarios autorizados con algún dispositivo activo (sin dispositivo no hay a quién enviar). */
async function recipients(tx: Prisma.TransactionClient, type: StaffNotificationType) {
  return tx.user.findMany({
    where: {
      role: { in: [...staffRecipientRules[type]] },
      active: true,
      deletedAt: null,
      pushSubscriptions: { some: { active: true } },
    },
    select: { id: true },
  });
}

/**
 * Encola el aviso «Nueva solicitud de cita» dentro de la transacción de la cita.
 * Solo para una solicitud real: pendiente de confirmar y no eliminada.
 */
export async function enqueueAppointmentRequested(
  tx: Prisma.TransactionClient,
  appointment: Appointment,
  now = new Date(),
) {
  if (appointment.status !== 'PENDING_LOCATION' || appointment.deletedAt) return [];
  const type: StaffNotificationType = 'APPOINTMENT_REQUESTED';
  const { title, body } = appointmentRequestedMessage(appointment);
  const ids: string[] = [];
  for (const user of await recipients(tx, type)) {
    const dedupeKey = staffNotificationKey(type, appointment.id, user.id);
    // Misma cita y destinatario: el segundo intento (webhook, reintento) no crea otro aviso.
    const row = await tx.notification.upsert({
      where: { dedupeKey },
      update: {},
      create: {
        dedupeKey,
        channel: 'WEB_PUSH',
        kind: type,
        appointmentId: appointment.id,
        recipient: user.id,
        data: { title, body, url: appointmentPanelPath(appointment.id), createdAt: now },
      },
    });
    ids.push(row.id);
  }
  return ids;
}

type Row = Notification & { appointment: Appointment | null };

/** Entrega una fila WEB_PUSH ya reclamada (status SENDING) por `deliverNotification`. */
export async function deliverStaffNotification(row: Row, now = new Date()) {
  const finish = (status: string, lastError: string | null, extra = {}) =>
    db.notification.update({ where: { id: row.id }, data: { status, lastError, ...extra } });
  const type = row.kind as StaffNotificationType;
  const allowed = staffRecipientRules[type];
  // El destinatario se comprueba al enviar: pudo perder el rol o ser desactivado.
  const user = await db.user.findUnique({
    where: { id: row.recipient },
    select: { role: true, active: true, deletedAt: true },
  });
  if (!allowed || !user || !user.active || user.deletedAt || !allowed.includes(user.role)) {
    await finish('CANCELLED', 'El destinatario ya no tiene permiso para este aviso');
    return 'CANCELLED' as const;
  }
  if (
    !row.appointment ||
    row.appointment.deletedAt ||
    (type === 'APPOINTMENT_REQUESTED' && row.appointment.status === 'CANCELLED')
  ) {
    await finish('CANCELLED', 'La cita fue cancelada o eliminada antes del envío');
    return 'CANCELLED' as const;
  }
  if (now.getTime() - row.createdAt.getTime() > STALE_AFTER_MS) {
    await finish('CANCELLED', 'Aviso caducado: no se envió a tiempo');
    return 'CANCELLED' as const;
  }
  const channel = staffChannel(row.channel);
  if (!channel) {
    await finish('FAILED', `Canal desconocido: ${row.channel}`);
    return 'FAILED' as const;
  }
  const data = row.data as { title: string; body: string; url: string; createdAt?: string };
  const payload: StaffPushPayload = {
    id: row.id,
    type,
    title: data.title,
    body: data.body,
    url: data.url,
    entityId: row.appointmentId,
    createdAt: row.createdAt.toISOString(),
  };
  let outcome;
  try {
    outcome = await channel.deliver(row.recipient, payload);
  } catch (error) {
    outcome = {
      status: 'RETRY' as const,
      reason: error instanceof Error ? error.message.slice(0, 200) : 'Error inesperado',
    };
  }
  logEvent('push.notification', { type, channel: row.channel, outcome: outcome.status });
  switch (outcome.status) {
    case 'SENT':
      await finish(
        'SENT',
        outcome.failed ? `${outcome.failed} dispositivo(s) no lo recibieron` : null,
        {
          sentAt: new Date(),
        },
      );
      return 'SENT' as const;
    case 'NO_DEVICES':
      // Sin dispositivos no hay nada que reintentar: queda registrado el motivo.
      await finish('SUPPRESSED', outcome.reason);
      return 'SKIPPED' as const;
    case 'FAILED':
      await finish('FAILED', outcome.reason);
      return 'FAILED' as const;
    case 'RETRY': {
      const failed = row.attempts >= MAX_ATTEMPTS;
      await finish(failed ? 'FAILED' : 'RETRY', outcome.reason, {
        dueAt: new Date(now.getTime() + Math.min(900000, 30000 * 2 ** row.attempts)),
      });
      return failed ? ('FAILED' as const) : ('RETRY' as const);
    }
  }
}
