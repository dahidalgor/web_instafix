import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Appointment, Prisma } from '@prisma/client';
import { db } from '../database/client';
import { appointmentEmailsEnabled, mailStatus, sendEmail } from '../mail/email.service';
import {
  appointmentCancelledEmail,
  appointmentCreatedEmail,
  appointmentRescheduledEmail,
  type AppointmentEmailData,
} from '../mail/templates';

export const appointmentEmailKinds = {
  APPOINTMENT_CREATED: appointmentCreatedEmail,
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
  appointment: Pick<Appointment, 'id' | 'startsAt'>,
) {
  return kind === 'APPOINTMENT_RESCHEDULED'
    ? `email:${appointment.id}:${kind}:${appointment.startsAt.toISOString()}`
    : `email:${appointment.id}:${kind}`;
}

/** Encola el correo dentro de la transacción que registra el cambio de la cita. */
export async function enqueueAppointmentEmail(
  tx: Prisma.TransactionClient,
  appointment: Appointment,
  kind: AppointmentEmailKind,
  extra: { previousStartsAt?: Date | null } = {},
) {
  if (!appointmentEmailsEnabled() || !appointment.contactEmail) return null;
  const data: AppointmentEmailData = {
    name: appointment.contactName || 'cliente',
    startsAt: appointment.startsAt.toISOString(),
    timeZone: appointment.timeZone,
    request: appointment.title,
    confirmed: appointment.status === 'CONFIRMED',
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
    row.kind !== 'APPOINTMENT_CANCELLED' &&
    (!row.appointment || row.appointment.status === 'CANCELLED')
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
  } catch {
    const failed = row.attempts >= MAX_ATTEMPTS;
    await db.notification.update({
      where: { id },
      data: {
        status: failed ? 'FAILED' : 'RETRY',
        lastError: 'El proveedor de correo no aceptó el mensaje',
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
    if (this.running || !mailStatus().configured) return;
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
    } catch {
      console.error('No se pudo procesar la bandeja de notificaciones');
    } finally {
      this.running = false;
    }
  }
}
