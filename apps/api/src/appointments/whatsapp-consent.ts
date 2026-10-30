import type { Appointment, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { publishAppointmentEvent } from '../notifications/appointment-events';

/**
 * Reserva hecha directo en Cal.com que el equipo autoriza tras hablar con el cliente: recupera
 * el flujo normal de una reserva de la web.
 *  - Vincula la cita a la cuenta de cliente cuyo teléfono (verificado con OTP) es el de la cita.
 *    El equipo acaba de confirmar con esa persona: es la misma verificación que hace el
 *    administrador al vincular una cuenta a mano.
 *  - Publica «cita creada»: aviso push a técnicos y administración y correo al cliente si tiene.
 *    Sin la autorización, el webhook no lo publicó. Ambos avisos se deduplican.
 * Se llama dentro de la transacción y con la cita bloqueada. Devuelve los correos a entregar
 * después del commit.
 */
export async function restoreBookingFlow(
  tx: Prisma.TransactionClient,
  appointment: Appointment,
  actorId: string,
  now = new Date(),
): Promise<{ appointment: Appointment; notifications: string[]; linked: boolean }> {
  let current = appointment;
  let linked = false;
  if (!current.userId && current.contactPhone && !current.bookingIdentityIssue) {
    const owner = await tx.user.findFirst({
      where: {
        phone: current.contactPhone,
        role: 'CUSTOMER',
        active: true,
        deletedAt: null,
        phoneVerifiedAt: { not: null },
      },
    });
    if (owner) {
      current = await tx.appointment.update({
        where: { id: current.id },
        data: {
          userId: owner.id,
          contactEmail: current.contactEmail || owner.email || null,
        },
      });
      linked = true;
      await tx.integrationEvent.create({
        data: {
          id: `account-link:${randomUUID()}`,
          provider: 'ACCOUNT_LINK',
          sourceId: current.id,
          occurredAt: now,
          outcome: `WHATSAPP_CONSENT:${owner.id}:BY:${actorId}`,
        },
      });
    }
  }
  // Solo una solicitud que aún espera técnico: avisar de una cita ya tomada no tiene sentido.
  const notifications =
    current.status === 'PENDING_LOCATION' && !current.assignedTechnicianId
      ? await publishAppointmentEvent(tx, current, { type: 'appointment.created' }, now)
      : [];
  return { appointment: current, notifications, linked };
}
