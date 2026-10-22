/**
 * Contrato de las notificaciones del equipo (Web Push hoy; push nativo de iOS/Android mañana).
 * Sin dependencias: lo usan la API (construye el aviso), el service worker (lo muestra) y las
 * pruebas. No incluye datos de contacto del cliente: solo lo necesario para abrir la cita.
 */

/** Hechos de negocio que pueden avisar al equipo. Hoy solo se envía APPOINTMENT_REQUESTED. */
export const staffNotificationTypes = [
  'APPOINTMENT_REQUESTED',
  'APPOINTMENT_CANCELLED',
  'APPOINTMENT_RESCHEDULED',
  'APPOINTMENT_ASSIGNED',
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
