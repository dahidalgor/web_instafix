import { BadRequestException, Controller, Get, Inject, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { authenticated, checkOrigin } from '../auth/session';
import { db } from '../database/client';
import { calConfiguration, whatsappConfiguration } from './config';
import { otpConfiguration } from './otp.provider';
import { auditAdmin } from '../security/admin-audit';
import { isConsentIssue } from './consent';
import { cancelPendingJobs, lockAppointment, queueJob, queueReminders } from './queue';
import { WhatsAppService } from './whatsapp.service';
import { WHATSAPP_BUDGET, eventTypeOf } from './budget';

/**
 * El número se conecta una sola vez en el panel de Bird (Coexistence); Instafix solo muestra su
 * estado. No hay botón de conexión en Administración.
 */
@Controller('api/v1/admin/whatsapp')
export class WhatsAppAdminController {
  constructor(@Inject(WhatsAppService) private readonly whatsapp: WhatsAppService) {}
  @Get() async status(@Req() req: Request) {
    await authenticated(req, true);
    const config = whatsappConfiguration();
    const [jobs, issues, events, messages, webhookIssues, account] = await Promise.all([
      db.automationJob.findMany({
        take: 100,
        orderBy: { createdAt: 'desc' },
        include: {
          appointment: {
            select: { contactName: true, contactPhone: true, title: true, startsAt: true },
          },
        },
      }),
      db.appointment.findMany({
        where: { automationIssue: { not: null }, status: { not: 'CANCELLED' }, deletedAt: null },
        take: 50,
        orderBy: { startsAt: 'asc' },
      }),
      db.integrationEvent.findMany({
        take: 20,
        orderBy: { createdAt: 'desc' },
        select: { provider: true, occurredAt: true, outcome: true },
      }),
      // Historial completo (también el de WasapFlow): no se pierde con la migración.
      db.whatsAppMessage.findMany({
        orderBy: { occurredAt: 'desc' },
        take: 50,
        select: {
          provider: true,
          providerMessageId: true,
          phone: true,
          bsuid: true,
          source: true,
          direction: true,
          type: true,
          text: true,
          occurredAt: true,
        },
      }),
      db.whatsAppWebhook.count({ where: { provider: config.provider, status: 'REVIEW' } }),
      config.configured || process.env.BIRD_API_KEY ? this.whatsapp.accountStatus() : null,
    ]);
    // Resultado de cada mensaje del cliente (p. ej. si su ubicación se asignó a una cita).
    const outcomes = new Map(
      (
        await db.integrationEvent.findMany({
          where: { id: { in: messages.map((m) => `wa:${m.providerMessageId}`) } },
          select: { id: true, outcome: true },
        })
      ).map((e) => [e.id.slice(3), e.outcome]),
    );
    return {
      whatsapp: config,
      account,
      otp: otpConfiguration(),
      cal: calConfiguration(),
      // Auditoría: cita, evento, canal, proveedor, estado (SENT, FAILED, PENDING o SUPPRESSED_*).
      jobs: jobs.map((job) => ({ ...job, channel: 'WHATSAPP', eventType: eventTypeOf(job.kind) })),
      budget: WHATSAPP_BUDGET,
      issues: issues.map((issue) => ({
        ...issue,
        needsConsent: isConsentIssue(issue.automationIssue),
      })),
      events,
      messages: messages.map((m) => ({ ...m, outcome: outcomes.get(m.providerMessageId) ?? null })),
      webhookIssues,
    };
  }
  /**
   * Reserva hecha directamente en Cal.com (sin la casilla de autorización): el equipo confirma
   * con el cliente que acepta WhatsApp y desde aquí se envía el primer mensaje.
   */
  @Post('appointments/:id/consent') async consent(@Param('id') id: string, @Req() req: Request) {
    checkOrigin(req);
    const admin = await authenticated(req, true);
    return db.$transaction(async (tx) => {
      await lockAppointment(tx, id);
      const current = await tx.appointment.findUnique({ where: { id } });
      if (!current || current.deletedAt || current.status === 'CANCELLED')
        throw new BadRequestException('Cita no encontrada');
      if (!current.contactPhone)
        throw new BadRequestException('La cita no tiene un teléfono válido');
      if (current.bookingIdentityIssue)
        throw new BadRequestException('Revisa primero la identidad del cliente de esta cita');
      await cancelPendingJobs(tx, id);
      const appointment = await tx.appointment.update({
        where: { id },
        data: {
          whatsappConsentAt: current.whatsappConsentAt || new Date(),
          automationRevision: { increment: 1 },
          ...(isConsentIssue(current.automationIssue) ? { automationIssue: null } : {}),
        },
      });
      const sends = appointment.status === 'PENDING_LOCATION' && !appointment.locationReceivedAt;
      if (sends) await queueJob(tx, appointment, 'INITIAL', new Date());
      await queueReminders(tx, appointment);
      await auditAdmin(admin.id, 'WHATSAPP_CONSENT_RECORDED', id, {}, tx);
      return { ok: true, queued: sends };
    });
  }
  @Post(':id/retry') async retry(@Param('id') id: string, @Req() req: Request) {
    checkOrigin(req);
    await authenticated(req, true);
    return db.$transaction(async (tx) => {
      const job = await tx.automationJob.findUnique({ where: { id } });
      if (!job) throw new BadRequestException('Mensaje no encontrado');
      await lockAppointment(tx, job.appointmentId);
      const current = await tx.automationJob.findUniqueOrThrow({ where: { id } });
      if (
        !(current.status === 'FAILED' || current.deliveryStatus === 'FAILED') ||
        current.expiresAt <= new Date()
      )
        throw new BadRequestException(
          'Solo se reintentan fallos confirmados y mensajes vigentes. Los envíos inciertos requieren revisión.',
        );
      await tx.automationJob.update({
        where: { id },
        data: {
          status: 'PENDING',
          attempts: 0,
          dueAt: new Date(),
          provider: null,
          providerMessageId: null,
          deliveryStatus: null,
          lastError: null,
        },
      });
      return { ok: true };
    });
  }
}
