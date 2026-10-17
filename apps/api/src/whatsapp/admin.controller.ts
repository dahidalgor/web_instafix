import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
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
    return this.onboarding.start(user.id);
  }
  @Post('connect/complete') async complete(@Req() req: Request, @Body() body: unknown) {
    checkOrigin(req);
    const user = await authenticated(req, true);
    return this.onboarding.complete(user.id, body);
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
        connectionMode: wabaId ? 'coexistence' : null,
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
