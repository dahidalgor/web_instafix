import type { Appointment, Prisma } from '@prisma/client';
import { queueJob, queueReminders } from '../whatsapp/queue';
import type { MessageKind } from '../whatsapp/messages';
import type { RequestOrigin } from '../security/client-identity';
import { enqueueAppointmentEmail } from './notification.service';
import { enqueueAppointmentRequested } from './staff/staff-notifications';

/**
 * Eventos internos de cita. AppointmentService publica el hecho una vez confirmado por
 * Cal.com y persistido; NotificationService decide los canales:
 *   email → Brevo (bandeja Notification)   ·   WhatsApp → Bird (cola AutomationJob)
 *   equipo → Web Push (bandeja Notification, channel WEB_PUSH; ver staff/staff-notifications)
 * Los OTP no pasan por aquí: pertenecen a VerificationService.
 */
export type AppointmentEvent =
  | { type: 'appointment.created' }
  | { type: 'appointment.rescheduled'; previousStartsAt: Date }
  | { type: 'appointment.cancelled' }
  | { type: 'appointment.confirmed'; technicianName: string }
  | { type: 'appointment.completed' };

export async function publishAppointmentEvent(
  tx: Prisma.TransactionClient,
  appointment: Appointment,
  event: AppointmentEvent,
  now = new Date(),
  /** Sesión/IP que provocó el hecho (presupuesto de WhatsApp). Sin él, el de la cita. */
  origin?: RequestOrigin | null,
) {
  const notifications: string[] = [];
  const email = async (
    kind: Parameters<typeof enqueueAppointmentEmail>[2],
    extra?: Parameters<typeof enqueueAppointmentEmail>[3],
  ) => {
    const id = await enqueueAppointmentEmail(tx, appointment, kind, extra);
    if (id) notifications.push(id);
  };
  // WhatsApp solo con consentimiento del cliente; cada aviso tiene su plantilla aprobada.
  const whatsapp = async (kind: MessageKind) => {
    if (appointment.whatsappConsentAt && appointment.contactPhone)
      await queueJob(tx, appointment, kind, now, appointment.startsAt, origin);
  };
  switch (event.type) {
    case 'appointment.created':
      // El WhatsApp inicial (solicitud de ubicación) lo encola el flujo de confirmación.
      await email('APPOINTMENT_CREATED');
      // Aviso al equipo. No se añade a `notifications`: esa lista se entrega en la misma
      // petición del cliente; el push lo envía el worker y nunca retrasa la reserva.
      await enqueueAppointmentRequested(tx, appointment, now);
      break;
    case 'appointment.rescheduled':
      await email('APPOINTMENT_RESCHEDULED', { previousStartsAt: event.previousStartsAt });
      await whatsapp('RESCHEDULED');
      break;
    case 'appointment.cancelled':
      await email('APPOINTMENT_CANCELLED');
      await whatsapp('CANCELLED');
      break;
    case 'appointment.confirmed':
      // Un técnico confirmó y quedó asignado: correo de Instafix + WhatsApp «cita confirmada».
      await email('APPOINTMENT_CONFIRMED', { technicianName: event.technicianName });
      await whatsapp('CONFIRMED');
      await queueReminders(tx, appointment, now);
      break;
    case 'appointment.completed':
      // Punto de extensión (encuesta, garantía, factura). Hoy no envía mensajes.
      break;
  }
  return notifications;
}
