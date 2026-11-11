import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { authenticated, checkOrigin } from '../auth/session';
import { db } from '../database/client';
import { pageParams } from '../common/pagination';
import { calConfiguration, whatsappConfiguration } from './config';
import { otpConfiguration } from './otp.provider';
import { restoreBookingFlow } from '../appointments/whatsapp-consent';
import { deliverNotification } from '../notifications/notification.service';
import { auditAdmin } from '../security/admin-audit';
import { calHealth } from '../integrations/cal-health';
import { isConsentIssue } from './consent';
import { cancelPendingJobs, lockAppointment, queueJob, queueReminders } from './queue';
import { WhatsAppService } from './whatsapp.service';
import { WHATSAPP_BUDGET, eventTypeOf } from './budget';

/**
 * El número se conecta una sola vez en el panel de Bird (Coexistence); Instafix solo muestra su
 * estado. No hay botón de conexión en Administración.
 */
/** Tamaño de página del historial de WhatsApp en Sistema. */
const PAGE = 20;

/** Auditoría de envíos: cita, evento, canal, proveedor, estado (SENT, FAILED, PENDING, SUPPRESSED_*). */
async function jobsPage(page: number, pageSize: number) {
  const [total, rows] = await Promise.all([
    db.automationJob.count(),
    db.automationJob.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        appointment: {
          select: { contactName: true, contactPhone: true, title: true, startsAt: true },
        },
      },
    }),
  ]);
  return {
    total,
    page,
    pageSize,
    items: rows.map((job) => ({ ...job, channel: 'WHATSAPP', eventType: eventTypeOf(job.kind) })),
  };
}

/** Mensajes (también el historial de WasapFlow), con el resultado de cada mensaje del cliente. */
async function messagesPage(page: number, pageSize: number) {
  const [total, rows] = await Promise.all([
    db.whatsAppMessage.count(),
    db.whatsAppMessage.findMany({
      orderBy: [{ occurredAt: 'desc' }, { providerMessageId: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
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
  ]);
  // Resultado de cada mensaje del cliente (p. ej. si su ubicación se asignó a una cita).
  const outcomes = new Map(
    (
      await db.integrationEvent.findMany({
        where: { id: { in: rows.map((m) => `wa:${m.providerMessageId}`) } },
        select: { id: true, outcome: true },
      })
    ).map((e) => [e.id.slice(3), e.outcome]),
  );
  return {
    total,
    page,
    pageSize,
    items: rows.map((m) => ({ ...m, outcome: outcomes.get(m.providerMessageId) ?? null })),
  };
}

@Controller('api/v1/admin/whatsapp')
export class WhatsAppAdminController {
  constructor(@Inject(WhatsAppService) private readonly whatsapp: WhatsAppService) {}
  @Get() async status(@Req() req: Request) {
    await authenticated(req, true);
    const config = whatsappConfiguration();
    const [jobs, issues, events, messages, webhookIssues, account] = await Promise.all([
      jobsPage(1, PAGE),
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
      // Solo los últimos mensajes; el historial completo se pide por páginas («Ver más»).
      messagesPage(1, PAGE),
      db.whatsAppWebhook.count({ where: { provider: config.provider, status: 'REVIEW' } }),
      config.configured || process.env.BIRD_API_KEY ? this.whatsapp.accountStatus() : null,
    ]);
    return {
      whatsapp: config,
      account,
      otp: otpConfiguration(),
      cal: calConfiguration(),
      // Auditoría: cita, evento, canal, proveedor, estado (SENT, FAILED, PENDING o SUPPRESSED_*).
      jobs: jobs.items,
      jobsTotal: jobs.total,
      budget: WHATSAPP_BUDGET,
      issues: issues.map((issue) => ({
        ...issue,
        needsConsent: isConsentIssue(issue.automationIssue),
      })),
      events,
      messages: messages.items,
      messagesTotal: messages.total,
      webhookIssues,
    };
  }
  /** Envíos de WhatsApp, del más reciente, por páginas. */
  @Get('jobs') async jobs(@Req() req: Request, @Query('page') page = '1') {
    await authenticated(req, true);
    return jobsPage(pageParams(page, PAGE).page, PAGE);
  }
  /** Mensajes de WhatsApp (entrantes y salientes), del más reciente, por páginas. */
  @Get('messages') async messages(@Req() req: Request, @Query('page') page = '1') {
    await authenticated(req, true);
    return messagesPage(pageParams(page, PAGE).page, PAGE);
  }
  /** Revisión de la agenda: horarios de los próximos 30 días y campos del evento en Cal.com. */
  @Get('cal-health') async calHealth(@Req() req: Request) {
    await authenticated(req, true);
    return calHealth();
  }
  /**
   * Reserva hecha directamente en Cal.com (sin la casilla de autorización): el equipo confirma
   * con el cliente que acepta WhatsApp y desde aquí se envía el primer mensaje.
   */
  @Post('appointments/:id/consent') async consent(@Param('id') id: string, @Req() req: Request) {
    checkOrigin(req);
    const admin = await authenticated(req, true);
    const outcome = await db.$transaction(async (tx) => {
      await lockAppointment(tx, id);
      const current = await tx.appointment.findUnique({ where: { id } });
      if (!current || current.deletedAt || current.status === 'CANCELLED')
        throw new BadRequestException('Cita no encontrada');
      if (!current.contactPhone)
        throw new BadRequestException('La cita no tiene un teléfono válido');
      if (current.bookingIdentityIssue)
        throw new BadRequestException('Revisa primero la identidad del cliente de esta cita');
      await cancelPendingJobs(tx, id);
      const wasPending = isConsentIssue(current.automationIssue);
      let appointment = await tx.appointment.update({
        where: { id },
        data: {
          whatsappConsentAt: current.whatsappConsentAt || new Date(),
          automationRevision: { increment: 1 },
          ...(wasPending ? { automationIssue: null } : {}),
        },
      });
      // Reserva que quedó fuera del flujo por falta de autorización: se normaliza.
      const restored = wasPending
        ? await restoreBookingFlow(tx, appointment, admin.id)
        : { appointment, notifications: [] as string[], linked: false };
      appointment = restored.appointment;
      const sends = appointment.status === 'PENDING_LOCATION' && !appointment.locationReceivedAt;
      if (sends) await queueJob(tx, appointment, 'INITIAL', new Date());
      await queueReminders(tx, appointment);
      await auditAdmin(admin.id, 'WHATSAPP_CONSENT_RECORDED', id, { linked: restored.linked }, tx);
      return { queued: sends, linked: restored.linked, notifications: restored.notifications };
    });
    for (const notification of outcome.notifications)
      await deliverNotification(notification).catch(() => {
        // La bandeja de avisos reintentará.
      });
    return { ok: true, queued: outcome.queued, linked: outcome.linked };
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
