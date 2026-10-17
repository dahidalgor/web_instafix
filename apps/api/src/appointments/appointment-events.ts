import type { Appointment, Prisma } from '@prisma/client';

// Eventos de dominio de la cita. Se guardan en la misma transacción que el cambio
// (patrón outbox) para que la mensajería pueda consumirlos sin acoplarse a la agenda.
// El siguiente bloque (WasapFlow) leerá AppointmentEvent con processedAt = null.
export const appointmentEventTypes = [
  'appointment.created',
  'appointment.confirmed',
  'appointment.rescheduled',
  'appointment.cancelled',
  'appointment.no_show',
  // Reservados para próximos bloques; todavía no se emiten.
  'appointment.reminder',
  'technician.assigned',
  'technician.on_the_way',
] as const;
export type AppointmentEventType = (typeof appointmentEventTypes)[number];

export async function emitAppointmentEvent(
  tx: Prisma.TransactionClient,
  appointment: Pick<Appointment, 'id' | 'status' | 'startsAt' | 'endsAt' | 'automationRevision'>,
  type: AppointmentEventType,
  extra: Record<string, string | null> = {},
) {
  // Un mismo hecho (tipo + revisión) solo se registra una vez aunque llegue repetido.
  const dedupeKey = `${appointment.id}:${type}:${appointment.automationRevision}`;
  await tx.appointmentEvent.upsert({
    where: { dedupeKey },
    update: {},
    create: {
      dedupeKey,
      appointmentId: appointment.id,
      type,
      payload: {
        status: appointment.status,
        startsAt: appointment.startsAt.toISOString(),
        endsAt: appointment.endsAt.toISOString(),
        ...extra,
      },
    },
  });
}
