import {
  appointmentPanelPath,
  appointmentRequestedMessage,
  completionReminderDelaysHours,
  completionReminderMessage,
  confirmationReminderMessage,
  confirmationReminderMinutes,
  DEFAULT_PUSH_URL,
  dailyAgendaHours,
  dailyAgendaMessage,
  type DailyAgendaStage,
  type StaffNotificationType,
  type StaffPushPayload,
} from '@instafix/contracts';
import type { Appointment, Notification, Prisma, Role } from '@prisma/client';
import { logEvent } from '../../common/log-event';
import { db } from '../../database/client';
import { dayIn } from '../../integrations/cal-client';
import { activeTimeBetween, confirmDeadline, isQuietTime } from '../../booking/hold';
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

/** Quién puede recibir cada tipo de aviso (rol activo, no eliminado, con dispositivo). */
export const staffRecipientRules: Record<StaffNotificationType, readonly Role[]> = {
  // Administración y técnicos: los técnicos son quienes confirman las citas pendientes.
  APPOINTMENT_REQUESTED: ['ADMIN', 'TECHNICIAN'],
  // Preparados, sin productor todavía. Un aviso a un técnico concreto usaría
  // `recipientIds` (p. ej. el técnico asignado) en lugar de todo el rol.
  APPOINTMENT_CANCELLED: ['ADMIN'],
  APPOINTMENT_RESCHEDULED: ['ADMIN'],
  APPOINTMENT_ASSIGNED: ['TECHNICIAN'],
  // Solo al técnico asignado a la visita (un administrador también puede tomar visitas).
  COMPLETION_REMINDER: ['ADMIN', 'TECHNICIAN'],
  // Cita pendiente sin confirmar: técnicos (y administración en el último aviso).
  CONFIRMATION_REMINDER: ['ADMIN', 'TECHNICIAN'],
  // Resumen diario de sus propias visitas (mañana a las 19H00, hoy a las 08H00).
  DAILY_AGENDA: ['ADMIN', 'TECHNICIAN'],
  // Prueba enviada por el propio usuario a sus dispositivos (POST /staff/push/test).
  TEST: ['ADMIN', 'TECHNICIAN'],
};

/** Tipos que hoy tienen un productor real (el resto está preparado en las reglas). */
export const producedStaffNotifications: readonly StaffNotificationType[] = [
  'APPOINTMENT_REQUESTED',
  'COMPLETION_REMINDER',
  'CONFIRMATION_REMINDER',
  'DAILY_AGENDA',
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

/** Estados en los que el trabajo aún puede (y debe) marcarse como completado. */
const OPEN_WORK = ['CONFIRMED', 'IN_PROGRESS'];

/**
 * Programa los recordatorios «marca el trabajo como completado» al técnico asignado: 2 h y 4 h
 * después del fin previsto (siempre con 2 h entre ambos, aunque se confirme tarde). Al enviarse
 * se comprueba que el trabajo siga abierto, con el mismo técnico y el mismo horario: completar,
 * cancelar, reasignar o reprogramar la cita anula los recordatorios pendientes sin enviarlos.
 * La clave incluye el fin previsto: tras reprogramar se programan unos nuevos.
 */
export async function scheduleCompletionReminders(
  tx: Prisma.TransactionClient,
  appointment: Appointment,
  now = new Date(),
) {
  const technicianId = appointment.assignedTechnicianId;
  if (!technicianId || !OPEN_WORK.includes(appointment.status) || appointment.deletedAt) return [];
  const type: StaffNotificationType = 'COMPLETION_REMINDER';
  const ends = appointment.endsAt.toISOString();
  const ids: string[] = [];
  let previous = 0;
  for (const [index, hours] of completionReminderDelaysHours.entries()) {
    const stage = (index + 1) as 1 | 2;
    const dueAt = new Date(
      Math.max(appointment.endsAt.getTime() + hours * 3600000, now.getTime(), previous),
    );
    previous = dueAt.getTime() + 2 * 3600000;
    const { title, body } = completionReminderMessage(appointment, stage);
    const dedupeKey = staffNotificationKey(
      type,
      `${appointment.id}:${ends}:${stage}`,
      technicianId,
    );
    const row = await tx.notification.upsert({
      where: { dedupeKey },
      update: {},
      create: {
        dedupeKey,
        channel: 'WEB_PUSH',
        kind: type,
        appointmentId: appointment.id,
        recipient: technicianId,
        dueAt,
        data: {
          title,
          body,
          url: appointmentPanelPath(appointment.id),
          createdAt: now,
          // Para validar al enviar y medir la caducidad desde la hora prevista, no la creación.
          scheduledFor: dueAt,
          endsAt: ends,
          stage,
        },
      },
    });
    ids.push(row.id);
  }
  return ids;
}

/**
 * Recordatorios para confirmar citas pendientes. Cada minuto, para cada cita que espera técnico
 * y tiene plazo, se calcula qué aviso le toca según el tiempo activo transcurrido (10 min, 30 min
 * y luego cada 30) y se crea una vez por destinatario (clave única por etapa). Si el worker se
 * retrasó, solo sale la etapa actual, nunca las atrasadas. A 30 min o menos del vencimiento sale
 * «Última oportunidad», también a administración. De noche (22H00–07H00) no se envía ninguno.
 */
export async function scheduleConfirmationReminders(now = new Date()) {
  if (isQuietTime(now)) return [];
  const pending = await db.appointment.findMany({
    where: {
      status: 'PENDING_LOCATION',
      assignedTechnicianId: null,
      deletedAt: null,
      holdExpiresAt: { gt: now },
    },
  });
  const ids: string[] = [];
  const { first, second, every, lastBefore } = confirmationReminderMinutes;
  for (const appointment of pending) {
    const deadline = confirmDeadline(appointment);
    if (!deadline || deadline <= now) continue;
    const since = appointment.holdStartedAt ?? appointment.createdAt;
    const last = deadline.getTime() - now.getTime() <= lastBefore * 60000;
    const elapsed = activeTimeBetween(since, now) / 60000;
    const stage = last
      ? 'LAST'
      : elapsed < first
        ? null
        : elapsed < second
          ? '1'
          : String(2 + Math.floor((elapsed - second) / every));
    if (!stage) continue;
    const type: StaffNotificationType = 'CONFIRMATION_REMINDER';
    const users = await db.user.findMany({
      where: {
        role: { in: last ? ['ADMIN', 'TECHNICIAN'] : ['TECHNICIAN'] },
        active: true,
        deletedAt: null,
        pushSubscriptions: { some: { active: true } },
      },
      select: { id: true },
    });
    const { title, body } = confirmationReminderMessage(appointment, deadline, now, last);
    for (const user of users) {
      const dedupeKey = staffNotificationKey(
        type,
        `${appointment.id}:${since.toISOString()}:${stage}`,
        user.id,
      );
      const row = await db.notification.upsert({
        where: { dedupeKey },
        update: {},
        create: {
          dedupeKey,
          channel: 'WEB_PUSH',
          kind: type,
          appointmentId: appointment.id,
          recipient: user.id,
          data: {
            title,
            body,
            url: appointmentPanelPath(appointment.id),
            createdAt: now,
            scheduledFor: now,
            holdStartedAt: since.toISOString(),
            stage,
          },
        },
      });
      ids.push(row.id);
    }
  }
  return ids;
}

const AGENDA_TIME_ZONE = 'America/Guayaquil';
/** Si la API estuvo detenida a la hora del resumen, aún se envía dentro de este margen. */
const AGENDA_WINDOW_HOURS = 3;

/**
 * Resumen diario al técnico de sus visitas confirmadas: a las 19H00 las de mañana y a las 08H00
 * las de hoy (hora de Ecuador). Se llama desde el worker; la clave única (día, tipo, técnico)
 * garantiza un solo aviso aunque se llame muchas veces o haya varias instancias. Sin visitas ese
 * día no se envía nada. Devuelve los ids creados o ya existentes.
 */
export async function scheduleDailyAgendas(now = new Date()) {
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: AGENDA_TIME_ZONE,
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(now),
  );
  const ids: string[] = [];
  for (const [stage, at] of Object.entries(dailyAgendaHours) as [DailyAgendaStage, number][]) {
    if (hour < at || hour >= at + AGENDA_WINDOW_HOURS) continue;
    // Ecuador no tiene horario de verano: el día empieza siempre a las 00H00 -05:00.
    const day = dayIn(new Date(now.getTime() + (stage === 'TOMORROW' ? 86400000 : 0)));
    const start = new Date(`${day}T00:00:00-05:00`);
    const jobs = await db.appointment.findMany({
      where: {
        status: { in: ['CONFIRMED', 'IN_PROGRESS'] },
        deletedAt: null,
        startsAt: { gte: start, lt: new Date(start.getTime() + 86400000) },
        assignedTechnician: {
          role: { in: [...staffRecipientRules.DAILY_AGENDA] },
          active: true,
          deletedAt: null,
          pushSubscriptions: { some: { active: true } },
        },
      },
      select: {
        id: true,
        assignedTechnicianId: true,
        contactName: true,
        startsAt: true,
        timeZone: true,
      },
    });
    const byTechnician = new Map<string, typeof jobs>();
    for (const job of jobs) {
      const list = byTechnician.get(job.assignedTechnicianId!) ?? [];
      list.push(job);
      byTechnician.set(job.assignedTechnicianId!, list);
    }
    for (const [technicianId, list] of byTechnician) {
      const { title, body } = dailyAgendaMessage(list, stage);
      const dedupeKey = staffNotificationKey('DAILY_AGENDA', `${day}:${stage}`, technicianId);
      const row = await db.notification.upsert({
        where: { dedupeKey },
        update: {},
        create: {
          dedupeKey,
          channel: 'WEB_PUSH',
          kind: 'DAILY_AGENDA',
          recipient: technicianId,
          data: {
            title,
            body,
            url: DEFAULT_PUSH_URL,
            createdAt: now,
            scheduledFor: now,
            day,
            stage,
            appointmentIds: list.map((job) => job.id),
          },
        },
      });
      ids.push(row.id);
    }
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
  // El resumen diario no pertenece a una cita: el resto sí y se anula si la cita ya no existe.
  if (
    type !== 'DAILY_AGENDA' &&
    (!row.appointment ||
      row.appointment.deletedAt ||
      (type === 'APPOINTMENT_REQUESTED' && row.appointment.status === 'CANCELLED'))
  ) {
    await finish('CANCELLED', 'La cita fue cancelada o eliminada antes del envío');
    return 'CANCELLED' as const;
  }
  const meta = row.data as {
    scheduledFor?: string;
    endsAt?: string;
    holdStartedAt?: string;
  };
  if (type === 'CONFIRMATION_REMINDER') {
    const a = row.appointment!;
    const since = (a.holdStartedAt ?? a.createdAt).toISOString();
    const reason =
      a.status !== 'PENDING_LOCATION' || a.assignedTechnicianId
        ? 'La cita ya se confirmó o se canceló'
        : meta.holdStartedAt && meta.holdStartedAt !== since
          ? 'La cita cambió de horario: hay recordatorios nuevos'
          : null;
    if (reason) {
      await finish('CANCELLED', reason);
      return 'CANCELLED' as const;
    }
  }
  if (type === 'COMPLETION_REMINDER') {
    const a = row.appointment!;
    const reason = !OPEN_WORK.includes(a.status)
      ? a.status === 'COMPLETED'
        ? 'El trabajo ya se marcó como completado'
        : 'La cita ya no está activa'
      : a.assignedTechnicianId !== row.recipient
        ? 'La cita ya no está asignada a este técnico'
        : meta.endsAt && a.endsAt.toISOString() !== meta.endsAt
          ? 'La cita se reprogramó: hay recordatorios nuevos'
          : null;
    if (reason) {
      await finish('CANCELLED', reason);
      return 'CANCELLED' as const;
    }
  }
  // Un aviso programado caduca contando desde su hora prevista, no desde que se creó.
  const since = meta.scheduledFor ? new Date(meta.scheduledFor).getTime() : row.createdAt.getTime();
  // El resumen del día solo sirve a su hora: pasado el margen ya no se envía.
  const staleAfter =
    type === 'DAILY_AGENDA'
      ? AGENDA_WINDOW_HOURS * 3600 * 1000
      : type === 'CONFIRMATION_REMINDER'
        ? 30 * 60000
        : STALE_AFTER_MS;
  if (now.getTime() - since > staleAfter) {
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
