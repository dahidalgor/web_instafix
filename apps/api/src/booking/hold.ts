import type { Appointment } from '@prisma/client';

/**
 * Reserva provisional de Instafix.
 *
 *   cliente agenda ──► cita pendiente + horario guardado solo en Instafix (no en Cal.com)
 *   técnico confirma ──► recién ahí se crea la reserva en Cal.com
 *   nadie confirma / el cliente no responde ──► se cancela sola y el horario queda libre
 *
 * Plazos (hora de Ecuador). Entre las 22H00 y las 07H00 el reloj se detiene: no corren los
 * plazos, no vence ninguna reserva y no salen avisos a técnicos.
 */
export const HOLD_RULES = {
  /** Tiempo para que un técnico confirme. */
  confirmHours: 4,
  /** Tiempo para que el cliente responda al WhatsApp inicial (ubicación o cualquier mensaje). */
  responseHours: 2,
  /** La reserva siempre vence al menos estas horas antes de la cita. */
  beforeStartHours: 3,
  /** Un horario que no deja al menos este tiempo para confirmar no se ofrece. */
  minimumMinutes: 30,
  quietStartHour: 22,
  quietEndHour: 7,
} as const;

const HOUR = 3600000;
const DAY = 24 * HOUR;
/** Ecuador continental: UTC-5 todo el año (sin horario de verano). */
const OFFSET = 5 * HOUR;

const localMs = (at: Date) => at.getTime() - OFFSET;
const dayStart = (at: Date) => Math.floor(localMs(at) / DAY) * DAY;
const hourOf = (at: Date) => (localMs(at) - dayStart(at)) / HOUR;
const fromLocal = (ms: number) => new Date(ms + OFFSET);

/** Entre las 22H00 y las 07H00 de Ecuador. */
export const isQuietTime = (at: Date) => {
  const hour = hourOf(at);
  return hour >= HOLD_RULES.quietStartHour || hour < HOLD_RULES.quietEndHour;
};

/** El mismo instante si es horario activo; si no, las 07H00 siguientes. */
export function nextActiveTime(at: Date) {
  if (!isQuietTime(at)) return at;
  const start = dayStart(at);
  const morning = start + HOLD_RULES.quietEndHour * HOUR;
  return fromLocal(hourOf(at) < HOLD_RULES.quietEndHour ? morning : morning + DAY);
}

/** El mismo instante si es horario activo; si no, las 22H00 en que empezó la noche. */
export function lastActiveTime(at: Date) {
  if (!isQuietTime(at)) return at;
  const start = dayStart(at);
  const night = start + HOLD_RULES.quietStartHour * HOUR;
  return fromLocal(hourOf(at) >= HOLD_RULES.quietStartHour ? night : night - DAY);
}

/** Suma tiempo contando solo las horas activas (07H00–22H00). */
export function addActiveTime(from: Date, ms: number) {
  let at = nextActiveTime(from);
  let remaining = ms;
  while (remaining > 0) {
    const close = fromLocal(dayStart(at) + HOLD_RULES.quietStartHour * HOUR);
    const chunk = Math.min(remaining, close.getTime() - at.getTime());
    remaining -= chunk;
    at = new Date(at.getTime() + chunk);
    if (remaining > 0) at = nextActiveTime(at);
  }
  return at;
}

/** Tiempo activo (07H00–22H00) entre dos instantes. */
export function activeTimeBetween(from: Date, to: Date) {
  let total = 0;
  let at = nextActiveTime(from);
  while (at < to) {
    const close = fromLocal(dayStart(at) + HOLD_RULES.quietStartHour * HOUR);
    const end = Math.min(close.getTime(), to.getTime());
    total += end - at.getTime();
    at = nextActiveTime(new Date(end));
  }
  return total;
}

/**
 * Vencimiento de la reserva provisional creada en `base` para una cita en `startsAt`:
 * 4 h activas para confirmar y, como tarde, 3 h antes de la cita (si eso cae de noche, a las
 * 22H00 anteriores). null si no quedan ni 30 min activos para confirmar: ese horario no se
 * ofrece ni se acepta (se cancelaría antes de que nadie pudiera confirmarlo).
 */
export function holdDeadline(base: Date, startsAt: Date) {
  let deadline = addActiveTime(base, HOLD_RULES.confirmHours * HOUR);
  const latest = new Date(startsAt.getTime() - HOLD_RULES.beforeStartHours * HOUR);
  if (latest < deadline) deadline = lastActiveTime(latest);
  return activeTimeBetween(base, deadline) >= HOLD_RULES.minimumMinutes * 60000 ? deadline : null;
}

/**
 * Vencimiento para una cita que ya existe y vuelve a esperar técnico (reserva directa en Cal.com,
 * reprogramación desde Cal.com, citas anteriores a este cambio). Nunca se rechaza: si no alcanza
 * el plazo normal, al menos 30 min (o 1 h activa si es de noche) y siempre antes de la cita.
 */
export function holdDeadlineForExisting(base: Date, startsAt: Date) {
  return (
    holdDeadline(base, startsAt) ??
    new Date(
      Math.max(
        base.getTime() + HOLD_RULES.minimumMinutes * 60000,
        Math.min(startsAt.getTime() - 15 * 60000, nextActiveTime(base).getTime() + HOUR),
      ),
    )
  );
}

/** Plazo para responder al WhatsApp inicial enviado en `sentAt`. */
export const responseDeadline = (sentAt: Date) =>
  addActiveTime(sentAt, HOLD_RULES.responseHours * HOUR);

/** Citas que usan la reserva provisional: las de la agenda (web o Cal.com), no las manuales. */
export const usesHold = (a: Pick<Appointment, 'calUid' | 'source'>) =>
  Boolean(a.calUid) || a.source === 'INSTAFIX_API';

/**
 * Momento en que la cita pendiente se cancela si nadie la confirma: el primero de los dos
 * plazos. El del cliente deja de contar en cuanto envía la ubicación o un mensaje.
 */
export function confirmDeadline(
  a: Pick<
    Appointment,
    | 'status'
    | 'assignedTechnicianId'
    | 'deletedAt'
    | 'holdExpiresAt'
    | 'responseDueAt'
    | 'locationReceivedAt'
  >,
) {
  if (a.status !== 'PENDING_LOCATION' || a.assignedTechnicianId || a.deletedAt) return null;
  const response = a.locationReceivedAt ? null : a.responseDueAt;
  const options = [a.holdExpiresAt, response].filter((d): d is Date => Boolean(d));
  return options.length ? new Date(Math.min(...options.map((d) => d.getTime()))) : null;
}

/** Motivos que ven administración y el historial. */
export const AUTO_CANCEL_REASONS = {
  NO_RESPONSE:
    'Cancelada automáticamente: el cliente no respondió por WhatsApp (ubicación o mensaje) a tiempo.',
  NOT_CONFIRMED: 'Cancelada automáticamente: ningún técnico la confirmó a tiempo.',
} as const;

/** Campos que reinician la reserva provisional cuando una cita vuelve a esperar técnico. */
export const resetHold = { holdStartedAt: null, holdExpiresAt: null, responseDueAt: null };
