import { logEvent } from '../common/log-event';
import { z } from 'zod';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Req,
  Inject,
} from '@nestjs/common';
import type { Request } from 'express';
import { authenticated, checkOrigin } from '../auth/session';
import { db } from '../database/client';
import { calConfiguration, whatsappConfiguration } from './config';
import { lockAppointment } from './queue';
import { WhatsAppOnboardingService } from './onboarding.service';
import { connectedWaba } from './connection';
import { otpConfiguration } from './otp.provider';

@Controller('api/v1/admin/whatsapp')
export class WhatsAppAdminController {
  constructor(
    @Inject(WhatsAppOnboardingService) private readonly onboarding: WhatsAppOnboardingService,
  ) {}
  @Post('connect/session') @Header('Cache-Control', 'no-store') async connect(@Req() req: Request) {
    checkOrigin(req);
    const user = await authenticated(req, true);
    try {
      const session = await this.onboarding.start(user.id);
      logEvent('whatsapp.connect_started', { connectOrigin: new URL(session.connect_url).origin });
      return session;
    } catch (error) {
      logEvent(
        'whatsapp.connect_start_failed',
        { reason: error instanceof Error ? error.message.slice(0, 300) : 'Error inesperado' },
        'warn',
      );
      throw error;
    }
  }
  @Post('connect/complete') async complete(@Req() req: Request, @Body() body: unknown) {
    checkOrigin(req);
    const user = await authenticated(req, true);
    try {
      const result = await this.onboarding.complete(user.id, body);
      logEvent('whatsapp.connect_completed', { connectionMode: result.connectionMode });
      return result;
    } catch (error) {
      logEvent(
        'whatsapp.connect_complete_failed',
        { reason: error instanceof Error ? error.message.slice(0, 300) : 'Error inesperado' },
        'warn',
      );
      throw error;
    }
  }
  /** Resultado observado en el navegador (cancelación, cierre sin respuesta…) para diagnóstico. */
  @Post('connect/event') @HttpCode(204) async connectEvent(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    checkOrigin(req);
    await authenticated(req, true);
    const parsed = z
      .object({
        outcome: z.enum([
          'WASAPFLOW_CANCEL',
          'WASAPFLOW_ERROR',
          'COMPLETE_FAILED',
          'POPUP_CLOSED_WITHOUT_RESULT',
          'SESSION_EXPIRED',
        ]),
        detail: z.string().max(300).optional(),
      })
      .strict()
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException('Evento no válido');
    logEvent('whatsapp.connect_outcome', parsed.data, 'warn');
  }
  @Get() async status(@Req() req: Request) {
    await authenticated(req, true);
    const [jobs, issues, events] = await Promise.all([
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
        where: { automationIssue: { not: null }, status: { not: 'CANCELLED' } },
        take: 50,
        orderBy: { startsAt: 'asc' },
      }),
      db.integrationEvent.findMany({
        take: 20,
        orderBy: { createdAt: 'desc' },
        select: { provider: true, occurredAt: true, outcome: true },
      }),
    ]);
    const wabaId = await connectedWaba();
    const messages = wabaId
      ? await db.whatsAppMessage.findMany({
          where: { wabaId },
          orderBy: { occurredAt: 'desc' },
          take: 50,
          select: {
            messageId: true,
            phone: true,
            bsuid: true,
            source: true,
            direction: true,
            type: true,
            text: true,
            occurredAt: true,
          },
        })
      : [];
    const webhookIssues = await db.bridgeWebhook.count({ where: { status: 'REVIEW' } });
    return {
      whatsapp: {
        ...whatsappConfiguration(),
        connected: !!wabaId,
        connectionMode: wabaId
          ? ((await db.whatsAppConnection.findUnique({ where: { id: 'main' } }))?.connectionMode ??
            null)
          : null,
      },
      otp: otpConfiguration(),
      cal: calConfiguration(),
      jobs,
      issues,
      events,
      messages,
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
        !(current.status === 'FAILED' || current.deliveryStatus === 'failed') ||
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
          providerId: null,
          deliveryStatus: null,
          lastError: null,
        },
      });
      return { ok: true };
    });
  }
}
