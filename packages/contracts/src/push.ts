/**
 * Contrato de las notificaciones del equipo (Web Push hoy; push nativo de iOS/Android mañana).
 * Sin dependencias: lo usan la API (construye el aviso), el service worker (lo muestra) y las
 * pruebas. No incluye datos de contacto del cliente: solo lo necesario para abrir la cita.
 */

/** Hechos de negocio que pueden avisar al equipo. */
export const staffNotificationTypes = [
  'APPOINTMENT_REQUESTED',
  'APPOINTMENT_CANCELLED',
  'APPOINTMENT_RESCHEDULED',
  'APPOINTMENT_ASSIGNED',
  /** Al técnico asignado: marcar como completado el trabajo (2 h y 4 h después del fin). */
  'COMPLETION_REMINDER',
  /** A los técnicos: una cita sigue sin confirmar y se cancelará si nadie la confirma. */
  'CONFIRMATION_REMINDER',
  /** A quienes están libres: un técnico pide que otro tome su visita confirmada. */
  'HANDOVER_REQUESTED',
  /** Al técnico que pidió reemplazo: alguien tomó su visita. */
  'HANDOVER_TAKEN',
  /** A administración: 24 h antes de la visita nadie tomó el reemplazo. */
  'HANDOVER_UNCLAIMED',
  /** Al técnico: sus trabajos de mañana (19H00) y de hoy (08H00). */
  'DAILY_AGENDA',
  /** Prueba que el propio usuario envía a sus dispositivos desde el panel. */
  'TEST',
] as const;
export type StaffNotificationType = (typeof staffNotificationTypes)[number];

/** Canales de entrega. Solo WEB_PUSH está implementado. */
export type StaffDeliveryChannel = 'WEB_PUSH' | 'APNS' | 'FCM';

/** Lo que recibe el dispositivo. Pequeño: Web Push admite ~4 KB cifrados. */
export type StaffPushPayload = {
  /** Identificador del aviso (también es la etiqueta: el mismo aviso no se apila dos veces). */
  id: string;
  type: StaffNotificationType;
  title: string;
  body: string;
  /** Ruta interna del panel (nunca una URL externa). */
  url: string;
  /** Entidad relacionada, opaca (UUID). */
  entityId: string | null;
  createdAt: string;
};

export const DEFAULT_PUSH_TITLE = 'Instafix';
export const DEFAULT_PUSH_URL = '/';
const MAX_TITLE = 120;
const MAX_BODY = 300;

/** Estado de las notificaciones para el panel (sin endpoint ni claves). */
export type StaffPushStatus = {
  configured: boolean;
  publicKey: string | null;
  /** Este dispositivo (por installationId) tiene una suscripción activa en el servidor. */
  device: {
    active: boolean;
    label: string;
    lastSuccessAt: string | null;
    failureReason: string | null;
  } | null;
  /** Dispositivos activos de la cuenta. */
  activeDevices: number;
  /** El rol de la cuenta recibe hoy algún aviso (los técnicos aún no reciben ninguno). */
  receivesNotifications: boolean;
};

/** Ruta del panel que abre una cita concreta. */
export const appointmentPanelPath = (appointmentId: string) =>
  `/#cita=${encodeURIComponent(appointmentId)}`;

/** Lee el `#cita=<id>` de un hash del panel; null si no es un enlace a una cita. */
export function appointmentIdFromHash(hash: string) {
  const match = /^#cita=([0-9a-fA-F-]{36})$/.exec(hash);
  return match ? match[1] : null;
}

/**
 * Destino seguro de un clic: solo rutas del mismo origen. Cualquier URL absoluta a otro
 * dominio, `//host`, `javascript:` o similar vuelve a la portada del panel.
 */
export function safeNotificationUrl(raw: unknown, origin: string) {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//'))
    return `${origin}${DEFAULT_PUSH_URL}`;
  try {
    const url = new URL(raw, origin);
    return url.origin === origin ? url.href : `${origin}${DEFAULT_PUSH_URL}`;
  } catch {
    return `${origin}${DEFAULT_PUSH_URL}`;
  }
}

/**
 * Normaliza lo recibido por el service worker: texto JSON, objeto o nada. Nunca lanza.
 * Sin datos válidos muestra un aviso genérico que abre el panel.
 */
export function parseStaffPushPayload(raw: unknown): StaffPushPayload {
  let data: unknown = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
  }
  const value = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const text = (input: unknown, max: number) =>
    typeof input === 'string' && input.trim() ? input.trim().slice(0, max) : '';
  const type = staffNotificationTypes.includes(value.type as StaffNotificationType)
    ? (value.type as StaffNotificationType)
    : 'APPOINTMENT_REQUESTED';
  const id = text(value.id, 100);
  return {
    id,
    type,
    title: text(value.title, MAX_TITLE) || DEFAULT_PUSH_TITLE,
    body: text(value.body, MAX_BODY) || 'Tienes un aviso nuevo en el panel.',
    url: typeof value.url === 'string' ? value.url : DEFAULT_PUSH_URL,
    entityId: text(value.entityId, 100) || null,
    createdAt: text(value.createdAt, 40) || new Date(0).toISOString(),
  };
}

/**
 * «Jueves 24 de octubre a las 12H00» en la zona horaria de la cita (no la del servidor).
 * Formato horario de Ecuador: 24 h con «H» como separador.
 */
export function formatAppointmentMoment(startsAt: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('es-EC', {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(startsAt);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  const weekday = get('weekday');
  return {
    day: `${weekday.charAt(0).toUpperCase()}${weekday.slice(1)} ${get('day')} de ${get('month')}`,
    time: `${get('hour')}H${get('minute')}`,
  };
}

/** Solo el primer nombre: suficiente para reconocer la cita en la pantalla bloqueada. */
export function customerFirstName(name: string | null | undefined) {
  const first = (name ?? '').trim().split(/\s+/)[0] ?? '';
  // Sin letras (vacío, teléfono, símbolos) no se muestra: se usa un texto genérico.
  return /\p{L}/u.test(first) ? first.slice(0, 40) : null;
}

/** Título y cuerpo del aviso de una solicitud de cita nueva. */
export function appointmentRequestedMessage(input: {
  contactName: string | null | undefined;
  startsAt: Date;
  timeZone: string;
}) {
  const { day, time } = formatAppointmentMoment(input.startsAt, input.timeZone);
  const who = customerFirstName(input.contactName) ?? 'Un cliente';
  return {
    title: 'Nueva solicitud de cita',
    body: `${who} está solicitando una cita para ${day} a las ${time}.`,
  };
}

/** Recordatorios para completar un trabajo: horas después del fin previsto de la visita. */
export const completionReminderDelaysHours = [2, 4] as const;

/**
 * Título y cuerpo del recordatorio al técnico para marcar el trabajo como completado.
 * `stage` 1 = primer aviso (2 h después del fin), 2 = segundo y último (4 h después).
 */
export function completionReminderMessage(
  input: { contactName: string | null | undefined; startsAt: Date; timeZone: string },
  stage: 1 | 2,
) {
  const { time } = formatAppointmentMoment(input.startsAt, input.timeZone);
  const who = customerFirstName(input.contactName);
  const visit = who ? `la visita de ${who}` : 'la visita';
  return stage === 1
    ? {
        title: `¿Terminaste ${visit}?`,
        body: `Marca como completado el trabajo de las ${time} y registra los servicios realizados.`,
      }
    : {
        title: `Falta completar ${visit}`,
        body: `El trabajo de las ${time} sigue sin completar. Márcalo para cerrar la cita y activar la garantía del cliente.`,
      };
}

/** Horas de Ecuador a las que sale el resumen de trabajos del técnico. */
export const dailyAgendaHours = { TOMORROW: 19, TODAY: 8 } as const;
export type DailyAgendaStage = keyof typeof dailyAgendaHours;

/**
 * Resumen de trabajos del técnico: «10H00 Saúl · 14H30 Ana». Ordenado por hora; si no cabe en
 * el aviso termina en «y N más».
 */
export function dailyAgendaMessage(
  jobs: { contactName: string | null | undefined; startsAt: Date; timeZone: string }[],
  stage: DailyAgendaStage,
) {
  const items = [...jobs]
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
    .map((job) => {
      const { time } = formatAppointmentMoment(job.startsAt, job.timeZone);
      return `${time} ${customerFirstName(job.contactName) ?? 'Cliente'}`;
    });
  let body = '';
  for (const [index, item] of items.entries()) {
    const rest = items.length - index - 1;
    const next = body ? `${body} · ${item}` : item;
    if (next.length + (rest ? ` y ${rest} más`.length : 0) > 250) {
      body = `${body} y ${items.length - index} más`;
      break;
    }
    body = next;
  }
  const count = `${items.length} ${items.length === 1 ? 'trabajo' : 'trabajos'}`;
  return stage === 'TODAY'
    ? { title: '¡Recuerda tus trabajos de hoy!', body }
    : { title: `Mañana tienes ${count}`, body };
}

/**
 * Recordatorios para confirmar una cita pendiente (minutos activos desde que llegó la cita):
 * a los 10, a los 30 y luego cada 30. El último aviso sale 30 min antes de que venza.
 */
export const confirmationReminderMinutes = { first: 10, second: 30, every: 30, lastBefore: 30 };

const lowerFirst = (text: string) => `${text.charAt(0).toLowerCase()}${text.slice(1)}`;

/** Título y cuerpo del aviso «confirma esta cita» (`last` = última oportunidad). */
export function confirmationReminderMessage(
  input: { contactName: string | null | undefined; startsAt: Date; timeZone: string },
  deadline: Date,
  now: Date,
  last: boolean,
) {
  const { day, time } = formatAppointmentMoment(input.startsAt, input.timeZone);
  const limit = formatAppointmentMoment(deadline, input.timeZone);
  const today = formatAppointmentMoment(now, input.timeZone).day === limit.day;
  const before = today
    ? `antes de las ${limit.time}`
    : `antes del ${lowerFirst(limit.day)} a las ${limit.time}`;
  const at = today ? `a las ${limit.time}` : `el ${lowerFirst(limit.day)} a las ${limit.time}`;
  const who = customerFirstName(input.contactName);
  const visit = `el ${lowerFirst(day)} a las ${time}`;
  return last
    ? {
        title: who
          ? `Última oportunidad: cita de ${who}`
          : 'Última oportunidad para confirmar una cita',
        body: `Se cancela ${at} si nadie la confirma. Es para ${visit}.`,
      }
    : {
        title: 'Cita pendiente por confirmar',
        body: `${who ?? 'Un cliente'} solicitó una cita para ${visit}. Confírmala ${before} o se cancelará.`,
      };
}

type VisitInput = { contactName: string | null | undefined; startsAt: Date; timeZone: string };
const visitText = (input: VisitInput) => {
  const { day, time } = formatAppointmentMoment(input.startsAt, input.timeZone);
  const who = customerFirstName(input.contactName);
  return `${who ? `la visita de ${who}` : 'una visita'} del ${lowerFirst(day)} a las ${time}`;
};

/** Reemplazo: un técnico necesita que otro tome su visita confirmada. */
export function handoverRequestedMessage(
  input: VisitInput,
  requester: string,
  reason: string | null | undefined,
) {
  return {
    title: '¿Puedes tomar esta visita?',
    body: `${requester} necesita un reemplazo para ${visitText(input)}.${reason ? ` Motivo: ${reason}.` : ''}`.slice(
      0,
      300,
    ),
  };
}

/** Reemplazo: alguien tomó la visita (al técnico que lo pidió). */
export function handoverTakenMessage(input: VisitInput, taker: string) {
  return {
    title: `${taker} tomó tu visita`,
    body: `${capitalizeFirst(visitText(input))} ya no está a tu cargo.`,
  };
}

/** Reemplazo: 24 h antes nadie lo tomó (a administración). */
export function handoverUnclaimedMessage(input: VisitInput, requester: string) {
  return {
    title: 'Nadie tomó un reemplazo',
    body: `${requester} pidió reemplazo para ${visitText(input)}. Reasígnala desde Citas o confirma con ${requester}.`,
  };
}

const capitalizeFirst = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
