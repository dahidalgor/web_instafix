import { logWorkerFailure } from '../common/log-event';
import { Injectable, type OnModuleInit, type OnModuleDestroy, Inject } from '@nestjs/common';
import type { Appointment } from '@prisma/client';
import { db } from '../database/client';
import { whatsappConfiguration, calConfiguration } from './config';
import { isMessageKind, reminderTimes, type MessageKind } from './messages';
import { confirmCalBooking } from '../integrations/cal-client';
import { ProviderError } from '../integrations/provider-error';
import { WhatsAppProviderError, type TemplateVariables } from './provider';
import { repairVariables } from '../repairs/repair-messages';
import { WhatsAppService } from './whatsapp.service';
import { lockAppointment, queueJob, queueReminders } from './queue';
import { deliveryState } from './delivery';
import { budgetVerdict, logSuppressed } from './budget';
import { responseDeadline, responseWarningTime, usesHold } from '../booking/hold';

type Providers = {
  send: (
    appointment: Appointment,
    kind: MessageKind,
    /** Valores propios del aviso (p. ej. el presupuesto de un trabajo de taller). */
    extra?: TemplateVariables,
  ) => Promise<{ providerMessageId: string; provider?: string }>;
  confirm: (uid: string) => Promise<void>;
};

/** Lo más que un aviso espera a que Meta apruebe su plantilla antes de descartarse. */
export const TEMPLATE_WAIT_MS = 2 * 3600000;
const TOO_LATE_MESSAGE = `No salió: la plantilla siguió en revisión de Meta más de ${TEMPLATE_WAIT_MS / 3600000} h y el aviso ya no era oportuno`;

/**
 * Desde cuándo un aviso espera la aprobación de su plantilla. Los que quedaron esperando con la
 * versión anterior (sin la marca) cuentan desde que se crearon.
 */
function templateWaitStart(job: {
  templateWaitSince: Date | null;
  lastError: string | null;
  createdAt: Date;
}) {
  if (job.templateWaitSince) return job.templateWaitSince;
  return job.lastError?.includes('revisión de Meta') ? job.createdAt : null;
}

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
    case 'LOCATION_REMINDER':
      // Solo mientras el cliente siga sin responder y la solicitud siga esperando.
      return (
        appointment.status === 'PENDING_LOCATION' &&
        !appointment.assignedTechnicianId &&
        !appointment.locationReceivedAt &&
        !!appointment.responseDueAt &&
        appointment.responseDueAt > new Date()
      );
    case 'LOCATION_RECEIVED':
      // «Apenas un técnico confirme…»: ya no aplica si un técnico la confirmó.
      return (
        appointment.status === 'PENDING_LOCATION' &&
        !appointment.assignedTechnicianId &&
        !!appointment.locationReceivedAt
      );
    case 'TECHNICIAN_CHANGED':
      return appointment.status === 'CONFIRMED' && !!appointment.assignedTechnicianId;
    case 'RESCHEDULE_PROPOSAL':
      return (
        appointment.status === 'CONFIRMED' &&
        !!appointment.proposedStartsAt &&
        !!appointment.proposalExpiresAt &&
        appointment.proposalExpiresAt > new Date()
      );
    case 'SAME_DAY':
      // Retirado: decía «mañana» el día de la visita. Los ya encolados se cancelan sin enviar.
      return false;
    case 'REPAIR_QUOTE':
    case 'REPAIR_RECEIVED':
    case 'REPAIR_READY':
      // Dependen del trabajo de taller, no de la cita (se comprueba en processJob).
      return true;
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
        // Presupuesto de taller: vale mientras el trabajo siga esperando la respuesta del cliente
        // (la visita ya pasó: no cuenta su fecha).
        const repairJob = job.kind.startsWith('REPAIR_');
        const repair =
          repairJob && job.repairOrderId
            ? await tx.repairOrder.findUnique({ where: { id: job.repairOrderId } })
            : null;
        // Cada aviso de taller vale solo en su estado: presupuesto sin responder, equipo aún en
        // el taller (comprobante) o listo para entregar.
        const repairOpen =
          !!repair &&
          (job.kind === 'REPAIR_QUOTE'
            ? repair.status === 'QUOTED' && !repair.quoteAnswer
            : job.kind === 'REPAIR_READY'
              ? repair.status === 'READY'
              : !['DELIVERED', 'RETURNED'].includes(repair.status));
        const invalid =
          Boolean(appointment.bookingIdentityIssue) ||
          Boolean(appointment.deletedAt) ||
          job.revision !== appointment.automationRevision ||
          !appointment.whatsappConsentAt ||
          !appointment.contactPhone ||
          job.expiresAt <= now ||
          (repairJob ? !repairOpen : appointment.startsAt <= now) ||
          // El recordatorio «mañana» solo sale antes del día de la visita (hora de Ecuador),
          // aunque la fila antigua tuviera otra caducidad.
          (job.kind === 'DAY_BEFORE' && now >= reminderTimes(appointment.startsAt).dayStart) ||
          !kindStillValid(job.kind, appointment);
        if (invalid) {
          await tx.automationJob.update({ where: { id }, data: { status: 'CANCELLED' } });
          return;
        }
        // Esperó demasiado a que Meta aprobara su plantilla: ya no es oportuno, aunque ahora se
        // pudiera enviar (no salen todos tarde y de golpe).
        const waitedSince = templateWaitStart(job);
        if (waitedSince && now.getTime() - waitedSince.getTime() >= TEMPLATE_WAIT_MS) {
          await tx.automationJob.update({
            where: { id },
            data: { status: 'CANCELLED', lastError: TOO_LATE_MESSAGE },
          });
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
            const sent = await providers.send(
              appointment,
              job.kind,
              repair ? repairVariables(repair) : undefined,
            );
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
            // Desde que sale el WhatsApp inicial corre el plazo para que el cliente responda.
            if (
              job.kind === 'INITIAL' &&
              appointment.status === 'PENDING_LOCATION' &&
              !appointment.assignedTechnicianId &&
              !appointment.locationReceivedAt &&
              usesHold(appointment)
            ) {
              const updated = await tx.appointment.update({
                where: { id: appointment.id },
                data: { responseDueAt: responseDeadline(now) },
              });
              // Una hora antes, si sigue sin responder: «envíanos la ubicación o se cancela».
              await queueJob(
                tx,
                updated,
                'LOCATION_REMINDER',
                responseWarningTime(now),
                updated.responseDueAt!,
              );
            }
          }
        } catch (error) {
          const failure =
            error instanceof ProviderError
              ? error
              : new ProviderError('Resultado incierto: revisión necesaria', 'REVIEW');
          // «Ubicación recibida» solo sale con su plantilla aprobada: sin ella no se manda otra
          // ni se reintenta (horas después ya no tendría sentido).
          const notApprovedYet =
            job.kind === 'LOCATION_RECEIVED' &&
            failure instanceof WhatsAppProviderError &&
            failure.code === 'TEMPLATE_NOT_APPROVED';
          // Plantilla en revisión de Meta: espera (reintento cada 15 min) y sale sola si Meta
          // aprueba a tiempo.
          // Solo mientras siga siendo oportuno: si Meta tarda más de TEMPLATE_WAIT_MS se
          // descarta, para que no salgan todos de golpe y tarde cuando Meta apruebe.
          const inReview =
            !notApprovedYet &&
            failure instanceof WhatsAppProviderError &&
            failure.code === 'TEMPLATE_NOT_APPROVED';
          const waitSince = templateWaitStart(job) ?? now;
          const tooLate = inReview && now.getTime() - waitSince.getTime() >= TEMPLATE_WAIT_MS;
          const waitingReview = inReview && !tooLate;
          const status =
            notApprovedYet || tooLate
              ? 'CANCELLED'
              : waitingReview
                ? 'RETRY'
                : failure.disposition === 'RETRY' && job.attempts >= 5
                  ? 'FAILED'
                  : failure.disposition;
          await tx.automationJob.update({
            where: { id },
            data: {
              status,
              lastError: tooLate ? TOO_LATE_MESSAGE : failure.message,
              dueAt: new Date(
                now.getTime() +
                  (waitingReview ? 15 * 60000 : Math.min(3600000, 60000 * 2 ** job.attempts)),
              ),
              ...(inReview ? { attempts: 0, templateWaitSince: waitSince } : {}),
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
          send: async (appointment, kind, extra) => ({
            ...(await this.whatsapp.sendAppointmentMessage(appointment, kind, extra)),
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
