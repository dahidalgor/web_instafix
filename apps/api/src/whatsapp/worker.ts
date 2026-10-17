import { Injectable, type OnModuleInit, type OnModuleDestroy, Inject } from '@nestjs/common';
import type { Appointment } from '@prisma/client';
import { db } from '../database/client';
import { whatsappConfiguration, calConfiguration } from './config';
import { type MessageKind } from './messages';
import { confirmCalBooking } from '../integrations/cal-client';
import { ProviderError } from '../integrations/provider-error';
import { WhatsAppService } from './whatsapp.service';
import { lockAppointment, queueJob, queueReminders } from './queue';
import { deliveryState } from './delivery';

type Providers = {
  send: (appointment: Appointment, kind: MessageKind) => Promise<string>;
  confirm: (uid: string) => Promise<void>;
};

/** Cada aviso solo es pertinente en ciertos estados; los obsoletos se cancelan sin enviar. */
export function kindStillValid(kind: string, appointment: Appointment) {
  switch (kind) {
    case 'INITIAL':
      return appointment.status === 'PENDING_LOCATION' && !appointment.locationReceivedAt;
    case 'CAL_CONFIRM':
      return appointment.status === 'PENDING_LOCATION' && Boolean(appointment.locationReceivedAt);
    case 'CANCELLED':
      return appointment.status === 'CANCELLED';
    case 'RESCHEDULED':
      return ['PENDING_LOCATION', 'CONFIRMED'].includes(appointment.status);
    case 'TECHNICIAN_ASSIGNED':
    case 'TECHNICIAN_ON_THE_WAY':
      return ['CONFIRMED', 'IN_PROGRESS'].includes(appointment.status);
    default:
      return appointment.status === 'CONFIRMED';
  }
}

export async function processJob(id: string, providers: Providers, now = new Date()) {
  const claimed = await db.automationJob.updateMany({
    where: { id, status: { in: ['PENDING', 'RETRY'] }, dueAt: { lte: now } },
    data: { status: 'SENDING', startedAt: now, attempts: { increment: 1 } },
  });
  if (!claimed.count) return;
  try {
    await db.$transaction(
      async (tx) => {
        const job = await tx.automationJob.findUniqueOrThrow({ where: { id } });
        await lockAppointment(tx, job.appointmentId);
        const appointment = await tx.appointment.findUniqueOrThrow({
          where: { id: job.appointmentId },
        });
        const isConfirm = job.kind === 'CAL_CONFIRM';
        const invalid =
          Boolean(appointment.bookingIdentityIssue) ||
          job.revision !== appointment.automationRevision ||
          !appointment.whatsappConsentAt ||
          !appointment.contactPhone ||
          job.expiresAt <= now ||
          // «En camino» puede llegar después de la hora estimada; su límite es expiresAt.
          (job.kind !== 'TECHNICIAN_ON_THE_WAY' && appointment.startsAt <= now) ||
          !kindStillValid(job.kind, appointment);
        if (invalid) {
          await tx.automationJob.update({ where: { id }, data: { status: 'CANCELLED' } });
          return;
        }
        try {
          if (isConfirm) {
            if (!appointment.calUid) throw new ProviderError('Falta reserva Cal', 'FAILED');
            await providers.confirm(appointment.calUid);
            const updated = await tx.appointment.update({
              where: { id: appointment.id },
              data: { status: 'CONFIRMED', calStatus: 'accepted', automationIssue: null },
            });
            await queueJob(tx, updated, 'CONFIRMED', now);
            await queueReminders(tx, updated, now);
            await tx.automationJob.update({
              where: { id },
              data: { status: 'SENT', lastError: null },
            });
          } else {
            const providerId = await providers.send(appointment, job.kind as MessageKind);
            const delivery = await deliveryState(tx, providerId);
            await tx.automationJob.update({
              where: { id },
              data: { status: 'SENT', providerId, ...delivery },
            });
          }
        } catch (error) {
          const failure =
            error instanceof ProviderError
              ? error
              : new ProviderError('Resultado incierto: revisión necesaria', 'REVIEW');
          const status =
            failure.disposition === 'RETRY' && job.attempts >= 5 ? 'FAILED' : failure.disposition;
          await tx.automationJob.update({
            where: { id },
            data: {
              status,
              lastError: failure.message,
              dueAt: new Date(now.getTime() + Math.min(3600000, 60000 * 2 ** job.attempts)),
            },
          });
          if (isConfirm)
            await tx.appointment.update({
              where: { id: appointment.id },
              data: { automationIssue: failure.message },
            });
        }
      },
      { timeout: 35000, maxWait: 5000 },
    );
  } catch {
    // Un fallo entre envío y persistencia es ambiguo: jamás reenviar WhatsApp a ciegas.
    await db.automationJob.updateMany({
      where: { id, status: 'SENDING' },
      data: {
        status: 'REVIEW',
        lastError: 'Ejecución interrumpida; comprueba el proveedor antes de reenviar',
      },
    });
  }
}

@Injectable()
export class WhatsAppWorker implements OnModuleInit, OnModuleDestroy {
  constructor(@Inject(WhatsAppService) private readonly whatsapp: WhatsAppService) {}
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  onModuleInit() {
    this.timer = setInterval(() => {
      void this.tick();
    }, 15000);
    this.timer.unref();
    void this.tick();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  async tick() {
    const config = whatsappConfiguration();
    if (this.running || !config.enabled || !config.configured || !calConfiguration().configured)
      return;
    this.running = true;
    try {
      if (!(await this.whatsapp.ensureConnection())) return;
      await db.automationJob.updateMany({
        where: { status: 'SENDING', startedAt: { lt: new Date(Date.now() - 300000) } },
        data: {
          status: 'REVIEW',
          lastError: 'Proceso interrumpido. Revisar el proveedor antes de reenviar.',
        },
      });
      const pending = await db.automationJob.findMany({
        where: { status: { in: ['PENDING', 'RETRY'] }, dueAt: { lte: new Date() } },
        orderBy: { dueAt: 'asc' },
        take: 20,
      });
      for (const job of pending)
        await processJob(job.id, {
          send: (appointment, kind) => this.whatsapp.sendAppointmentMessage(appointment, kind),
          confirm: confirmCalBooking,
        });
    } catch {
      console.error('No se pudo procesar la cola de WhatsApp');
    } finally {
      this.running = false;
    }
  }
}
