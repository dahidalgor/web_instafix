import { logWorkerFailure } from '../common/log-event';
import { Injectable, type OnModuleInit, type OnModuleDestroy, Inject } from '@nestjs/common';
import type { Appointment } from '@prisma/client';
import { db } from '../database/client';
import { whatsappConfiguration, calConfiguration } from './config';
import { isMessageKind, reminderTimes, type MessageKind } from './messages';
import { confirmCalBooking } from '../integrations/cal-client';
import { ProviderError } from '../integrations/provider-error';
import { WhatsAppService } from './whatsapp.service';
import { lockAppointment, queueJob, queueReminders } from './queue';
import { deliveryState } from './delivery';
import { budgetVerdict, logSuppressed } from './budget';

type Providers = {
  send: (
    appointment: Appointment,
    kind: MessageKind,
  ) => Promise<{ providerMessageId: string; provider?: string }>;
  confirm: (uid: string) => Promise<void>;
};

/** Cada aviso solo es pertinente en ciertos estados; los obsoletos se cancelan sin enviar. */
export function kindStillValid(kind: string, appointment: Appointment) {
  switch (kind) {
    case 'INITIAL':
      // La ubicación se pide hasta recibirla, aunque un técnico ya haya confirmado.
      return (
        ['PENDING_LOCATION', 'CONFIRMED'].includes(appointment.status) &&
        !appointment.locationReceivedAt
      );
    case 'CAL_CONFIRM':
      // Obsoleto: la ubicación ya no confirma la visita; la confirma un técnico.
      return false;
    case 'CANCELLED':
      return appointment.status === 'CANCELLED';
    case 'RESCHEDULED':
      return ['PENDING_LOCATION', 'CONFIRMED'].includes(appointment.status);
    case 'CONFIRMED':
    case 'DAY_BEFORE':
      return appointment.status === 'CONFIRMED';
    case 'SAME_DAY':
      // Retirado: decía «mañana» el día de la visita. Los ya encolados se cancelan sin enviar.
      return false;
    default:
      // Avisos retirados (p. ej. «técnico en camino», sin plantilla): se cancelan sin enviar.
      return false;
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
          Boolean(appointment.deletedAt) ||
          job.revision !== appointment.automationRevision ||
          !appointment.whatsappConsentAt ||
          !appointment.contactPhone ||
          job.expiresAt <= now ||
          appointment.startsAt <= now ||
          // El recordatorio «mañana» solo sale antes del día de la visita (hora de Ecuador),
          // aunque la fila antigua tuviera otra caducidad.
          (job.kind === 'DAY_BEFORE' && now >= reminderTimes(appointment.startsAt).dayStart) ||
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
            if (!isMessageKind(job.kind)) throw new ProviderError('Aviso desconocido', 'FAILED');
            // Presupuesto de WhatsApp: sin él no se llama a Bird. La cita ya quedó guardada;
            // el aviso se marca como suprimido y jamás se reintenta (no derrota el límite).
            const verdict = await budgetVerdict(tx, job, appointment, now);
            if (verdict) {
              await tx.automationJob.update({
                where: { id },
                data: { status: verdict.status, suppressedReason: verdict.reason, lastError: null },
              });
              logSuppressed(job, verdict.status, verdict.reason);
              return;
            }
            const sent = await providers.send(appointment, job.kind);
            const delivery = await deliveryState(tx, sent.providerMessageId);
            await tx.automationJob.update({
              where: { id },
              data: {
                status: 'SENT',
                provider: sent.provider ?? null,
                providerMessageId: sent.providerMessageId,
                ...delivery,
              },
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
          send: async (appointment, kind) => ({
            ...(await this.whatsapp.sendAppointmentMessage(appointment, kind)),
            provider: this.whatsapp.providerName,
          }),
          confirm: confirmCalBooking,
        });
    } catch (error) {
      logWorkerFailure('whatsapp.queue', error);
    } finally {
      this.running = false;
    }
  }
}
