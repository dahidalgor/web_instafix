import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Appointment, Prisma } from '@prisma/client';
import { maskRecipient } from '../communications/log';
import { retryCalConfirmations } from '../staff/staff-appointments.service';
import { db } from '../database/client';
import {
  appointmentEmailsEnabled,
  EmailDeliveryError,
  mailStatus,
  sendEmail,
} from '../mail/email.service';
import {
  appointmentCancelledEmail,
  appointmentConfirmedEmail,
  appointmentCreatedEmail,
  appointmentRescheduledEmail,
  type AppointmentEmailData,
} from '../mail/templates';

export const appointmentEmailKinds = {
  APPOINTMENT_CREATED: appointmentCreatedEmail,
  APPOINTMENT_CONFIRMED: appointmentConfirmedEmail,
  APPOINTMENT_RESCHEDULED: appointmentRescheduledEmail,
  APPOINTMENT_CANCELLED: appointmentCancelledEmail,
} as const;
export type AppointmentEmailKind = keyof typeof appointmentEmailKinds;
const MAX_ATTEMPTS = 5;

/**
 * Clave estable por hecho de negocio. La API y el webhook de Cal.com del mismo hecho
 * producen la misma clave, así que solo puede existir un correo por transición.
 */
export function notificationKey(
  kind: AppointmentEmailKind,
  appointment: Pick<Appointment, 'id' | 'startsAt'> & { confirmedAt?: Date | null },
) {
  if (kind === 'APPOINTMENT_RESCHEDULED')
    return `email:${appointment.id}:${kind}:${appointment.startsAt.toISOString()}`;
  // Una confirmación por asignación: tras reprogramar y volver a confirmar hay un aviso nuevo.
  if (kind === 'APPOINTMENT_CONFIRMED')
    return `email:${appointment.id}:${kind}:${appointment.confirmedAt?.toISOString() ?? 'none'}`;
  return `email:${appointment.id}:${kind}`;
}

/** Motivo por el que una cita no genera correo; se registra para poder diagnosticarlo. */
export function appointmentEmailSkipReason(appointment: Pick<Appointment, 'contactEmail'>) {
  if (!appointmentEmailsEnabled())
    return 'Avisos de citas desactivados con APPOINTMENT_EMAILS_ENABLED=false';
  if (!appointment.contactEmail) return 'La cita no tiene correo del cliente';
  return null;
}

/** Encola el correo dentro de la transacción que registra el cambio de la cita. */
export async function enqueueAppointmentEmail(
  tx: Prisma.TransactionClient,
  appointment: Appointment,
  kind: AppointmentEmailKind,
  extra: { previousStartsAt?: Date | null; technicianName?: string | null } = {},
) {
  const skipped = appointmentEmailSkipReason(appointment);
  if (skipped || !appointment.contactEmail) {
    // Queda constancia del aviso no enviado (sin destinatario real) para diagnosticarlo.
    await tx.communicationLog.create({
      data: {
        channel: 'EMAIL',
        provider: 'INSTAFIX',
        kind,
        recipient: appointment.contactEmail ? maskRecipient(appointment.contactEmail) : '—',
        status: 'SKIPPED',
        error: skipped,
        appointmentId: appointment.id,
        userId: appointment.userId,
      },
    });
    return null;
  }
  const data: AppointmentEmailData = {
    name: appointment.contactName || 'cliente',
    startsAt: appointment.startsAt.toISOString(),
    timeZone: appointment.timeZone,
    request: appointment.title,
    confirmed: appointment.status === 'CONFIRMED',
    technicianName: extra.technicianName ?? (appointment.technician || null),
    guest: !appointment.userId,
    previousStartsAt: extra.previousStartsAt?.toISOString() ?? null,
  };
  const dedupeKey = notificationKey(kind, appointment);
  const existing = await tx.notification.findUnique({ where: { dedupeKey } });
  if (existing) return existing.id;
  const created = await tx.notification.create({
    data: {
      dedupeKey,
      channel: 'EMAIL',
      kind,
      appointmentId: appointment.id,
      recipient: appointment.contactEmail,
      data,
    },
  });
  return created.id;
}

export type DeliveryResult = 'SENT' | 'RETRY' | 'FAILED' | 'CANCELLED' | 'SKIPPED';

/** Entrega una notificación reclamada atómicamente; nunca envía dos veces la misma fila. */
export async function deliverNotification(id: string, now = new Date()): Promise<DeliveryResult> {
  const claimed = await db.notification.updateMany({
    where: { id, status: { in: ['PENDING', 'RETRY'] }, dueAt: { lte: now } },
    data: { status: 'SENDING', attempts: { increment: 1 } },
  });
  if (!claimed.count) return 'SKIPPED';
  const row = await db.notification.findUniqueOrThrow({
    where: { id },
    include: { appointment: true },
  });
  // Un aviso de cita creada/reprogramada no se envía si la cita ya fue cancelada.
  if (
    (row.kind !== 'APPOINTMENT_CANCELLED' &&
      (!row.appointment || row.appointment.status === 'CANCELLED')) ||
    // Una confirmación pendiente pierde sentido si la cita volvió a quedar sin técnico.
    (row.kind === 'APPOINTMENT_CONFIRMED' && !row.appointment?.assignedTechnicianId)
  ) {
    await db.notification.update({ where: { id }, data: { status: 'CANCELLED' } });
    return 'CANCELLED';
  }
  const render = appointmentEmailKinds[row.kind as AppointmentEmailKind];
  try {
    const result = await sendEmail({
      to: row.recipient,
      kind: row.kind,
      appointmentId: row.appointmentId,
      userId: row.appointment?.userId,
      message: render(row.data as AppointmentEmailData),
    });
    await db.notification.update({
      where: { id },
      data: {
        status: 'SENT',
        providerMessageId: result.messageId,
        sentAt: new Date(),
        lastError: null,
      },
    });
    return 'SENT';
  } catch (error) {
    const failed = row.attempts >= MAX_ATTEMPTS;
    await db.notification.update({
      where: { id },
      data: {
        status: failed ? 'FAILED' : 'RETRY',
        lastError:
          error instanceof EmailDeliveryError
            ? `Brevo/SMTP rechazó el mensaje: ${error.reason}`
            : error instanceof Error
              ? error.message.slice(0, 300)
              : 'El proveedor de correo no aceptó el mensaje',
        dueAt: new Date(now.getTime() + Math.min(3600000, 60000 * 2 ** row.attempts)),
      },
    });
    return failed ? 'FAILED' : 'RETRY';
  }
}

@Injectable()
export class NotificationWorker implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  onModuleInit() {
    this.timer = setInterval(() => void this.tick(), 15000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  async tick() {
    if (this.running) return;
    // Confirmaciones de técnicos que Cal.com aún no reflejó: independiente del correo.
    await retryCalConfirmations().catch(() => console.error('No se pudo sincronizar con Cal.com'));
    if (!mailStatus().configured) return;
    this.running = true;
    try {
      // Un proceso interrumpido durante el envío queda en revisión: no se reenvía a ciegas.
      await db.notification.updateMany({
        where: { status: 'SENDING', updatedAt: { lt: new Date(Date.now() - 300000) } },
        data: {
          status: 'REVIEW',
          lastError: 'Envío interrumpido; revisar en Brevo antes de repetir',
        },
      });
      const due = await db.notification.findMany({
        where: { status: { in: ['PENDING', 'RETRY'] }, dueAt: { lte: new Date() } },
        orderBy: { dueAt: 'asc' },
        take: 20,
        select: { id: true },
      });
      for (const { id } of due) await deliverNotification(id);
    } catch (error) {
      console.error(
        'No se pudo procesar la bandeja de notificaciones:',
        error instanceof Error ? error.message : error,
      );
    } finally {
      this.running = false;
    }
  }
}
