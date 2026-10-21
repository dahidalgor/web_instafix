import type { Appointment, AutomationJob, Prisma } from '@prisma/client';
import { logEvent } from '../common/log-event';
import { isPhoneBlocked } from '../security/blocked-phones';

/**
 * Presupuesto de WhatsApp saliente (Bird factura cada mensaje). Es una regla de comunicación,
 * no de negocio: se evalúa en el worker, DESPUÉS de que la operación de la cita ya se guardó.
 * Si no hay presupuesto, el aviso queda como SUPPRESSED_* (nunca se reintenta) y la cita sigue
 * su curso normal. Un flujo normal usa 1–5 mensajes por cita; los topes son el margen de seguridad.
 */
export const WHATSAPP_BUDGET = {
  /** Máximo absoluto por sesión de cliente (cookie de sesión o de invitado), 30 días. */
  perSession: 10,
  /** Por cita, durante toda su vida. */
  perAppointment: 10,
  /** Por teléfono de destino en 24 h (borrar cookies no sirve para saltarlo). */
  perPhoneDay: 10,
  /** Por IP de origen (hash) en 24 h. */
  perIpDay: 20,
  /** Por cuenta de cliente en 30 días (todas sus sesiones). */
  perUserMonth: 20,
  /** Por tipo de aviso y cita: deduplicación además de la clave por revisión. */
  perKind: {
    INITIAL: 2,
    CONFIRMED: 3,
    RESCHEDULED: 2,
    CANCELLED: 1,
    DAY_BEFORE: 2,
    SAME_DAY: 2,
  } as Record<string, number>,
} as const;

/** Mensajes que cuentan como gastados: aceptados por Bird o con resultado incierto. */
export const CONSUMED = ['SENT', 'SENDING', 'REVIEW'];
export const SUPPRESSED_STATUSES = [
  'SUPPRESSED_BUDGET',
  'SUPPRESSED_RATE_LIMIT',
  'SUPPRESSED_DISABLED',
  'SUPPRESSED_BLOCKED',
] as const;
export type Suppression = (typeof SUPPRESSED_STATUSES)[number];

/** Interruptor general: WHATSAPP_SENDING_ENABLED=false corta todo envío a Bird. */
export const whatsappSendingEnabled = () => process.env.WHATSAPP_SENDING_ENABLED !== 'false';

/** Nombre del evento de negocio que origina cada aviso (auditoría). */
export function eventTypeOf(kind: string, reconfirmation = false) {
  switch (kind) {
    case 'INITIAL':
      return 'APPOINTMENT_CREATED';
    case 'CONFIRMED':
      return reconfirmation ? 'APPOINTMENT_RECONFIRMED' : 'APPOINTMENT_CONFIRMED';
    case 'RESCHEDULED':
      return 'APPOINTMENT_RESCHEDULED';
    case 'CANCELLED':
      return 'APPOINTMENT_CANCELLED';
    case 'DAY_BEFORE':
    case 'SAME_DAY':
      return 'APPOINTMENT_REMINDER';
    default:
      return kind;
  }
}

const day = 86400000;
/**
 * ¿Puede salir este aviso? Devuelve null si sí, o el estado de supresión y su motivo.
 * Se llama dentro de la transacción del worker, con un bloqueo global de presupuesto para que
 * dos envíos simultáneos no superen el tope.
 */
export async function budgetVerdict(
  tx: Prisma.TransactionClient,
  job: AutomationJob,
  appointment: Appointment,
  now = new Date(),
): Promise<{ status: Suppression; reason: string } | null> {
  if (!whatsappSendingEnabled())
    return { status: 'SUPPRESSED_DISABLED', reason: 'WHATSAPP_SENDING_ENABLED=false' };
  if (await isPhoneBlocked(appointment.contactPhone, tx))
    return { status: 'SUPPRESSED_BLOCKED', reason: 'Número bloqueado' };
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('whatsapp-budget'))`;
  const spent = (where: Prisma.AutomationJobWhereInput) =>
    tx.automationJob.count({ where: { ...where, id: { not: job.id }, status: { in: CONSUMED } } });
  const since = (ms: number) => ({ startedAt: { gt: new Date(now.getTime() - ms) } });

  const kindLimit = WHATSAPP_BUDGET.perKind[job.kind] ?? 1;
  if ((await spent({ appointmentId: job.appointmentId, kind: job.kind })) >= kindLimit)
    return { status: 'SUPPRESSED_BUDGET', reason: `Tope de avisos ${job.kind} de la cita` };
  if ((await spent({ appointmentId: job.appointmentId })) >= WHATSAPP_BUDGET.perAppointment)
    return { status: 'SUPPRESSED_BUDGET', reason: 'Tope de mensajes de la cita' };
  if (
    job.originSessionKey &&
    (await spent({ originSessionKey: job.originSessionKey, ...since(30 * day) })) >=
      WHATSAPP_BUDGET.perSession
  )
    return { status: 'SUPPRESSED_BUDGET', reason: 'Tope de mensajes de la sesión' };
  if (
    appointment.userId &&
    (await spent({ appointment: { userId: appointment.userId }, ...since(30 * day) })) >=
      WHATSAPP_BUDGET.perUserMonth
  )
    return { status: 'SUPPRESSED_BUDGET', reason: 'Tope de mensajes de la cuenta' };
  const recipient = job.recipient || appointment.contactPhone;
  if ((await spent({ recipient, ...since(day) })) >= WHATSAPP_BUDGET.perPhoneDay)
    return { status: 'SUPPRESSED_RATE_LIMIT', reason: 'Tope diario del número' };
  if (
    job.originIpHash &&
    (await spent({ originIpHash: job.originIpHash, ...since(day) })) >= WHATSAPP_BUDGET.perIpDay
  )
    return { status: 'SUPPRESSED_RATE_LIMIT', reason: 'Tope diario de la IP de origen' };
  return null;
}

export function logSuppressed(job: AutomationJob, status: Suppression, reason: string) {
  logEvent(
    'whatsapp.suppressed',
    {
      appointmentId: job.appointmentId,
      kind: job.kind,
      event: eventTypeOf(job.kind),
      status,
      reason,
    },
    'warn',
  );
}
