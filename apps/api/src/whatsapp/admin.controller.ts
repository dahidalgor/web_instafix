import { BadRequestException, Controller, Get, Inject, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { authenticated, checkOrigin } from '../auth/session';
import { db } from '../database/client';
import { calConfiguration, whatsappConfiguration } from './config';
import { otpConfiguration } from './otp.provider';
import { lockAppointment } from './queue';
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
      issues,
      events,
      messages: messages.map((m) => ({ ...m, outcome: outcomes.get(m.providerMessageId) ?? null })),
      webhookIssues,
    };
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
