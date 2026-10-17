import type { Appointment, Prisma } from '@prisma/client';
import { queueJob, queueReminders } from '../whatsapp/queue';
import { templateFor } from '../whatsapp/messages';
import { enqueueAppointmentEmail } from './notification.service';

/**
 * Eventos internos de cita. AppointmentService publica el hecho una vez confirmado por
 * Cal.com y persistido; NotificationService decide los canales:
 *   email → Brevo (bandeja Notification)   ·   WhatsApp → WasapFlow (cola AutomationJob)
 * Los OTP no pasan por aquí: pertenecen a VerificationService.
 */
export type AppointmentEvent =
  | { type: 'appointment.created' }
  | { type: 'appointment.rescheduled'; previousStartsAt: Date }
  | { type: 'appointment.cancelled' }
  | { type: 'appointment.confirmed'; technicianName: string }
  | { type: 'appointment.completed' }
  | { type: 'appointment.technician_assigned' }
  | { type: 'appointment.technician_on_the_way' };

export async function publishAppointmentEvent(
  tx: Prisma.TransactionClient,
  appointment: Appointment,
  event: AppointmentEvent,
  now = new Date(),
) {
  const notifications: string[] = [];
  const email = async (
    kind: Parameters<typeof enqueueAppointmentEmail>[2],
    extra?: Parameters<typeof enqueueAppointmentEmail>[3],
  ) => {
    const id = await enqueueAppointmentEmail(tx, appointment, kind, extra);
    if (id) notifications.push(id);
  };
  // WhatsApp solo con consentimiento y una plantilla aprobada configurada para ese aviso.
  const whatsapp = async (kind: Parameters<typeof templateFor>[0]) => {
    if (appointment.whatsappConsentAt && appointment.contactPhone && templateFor(kind))
      await queueJob(
        tx,
        appointment,
        kind,
        now,
        kind === 'TECHNICIAN_ON_THE_WAY' ? appointment.endsAt : appointment.startsAt,
      );
  };
  switch (event.type) {
    case 'appointment.created':
      // El WhatsApp inicial (solicitud de ubicación) lo encola el flujo de confirmación.
      await email('APPOINTMENT_CREATED');
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
    case 'appointment.technician_assigned':
      await whatsapp('TECHNICIAN_ASSIGNED');
      break;
    case 'appointment.technician_on_the_way':
      await whatsapp('TECHNICIAN_ON_THE_WAY');
      break;
  }
  return notifications;
}
