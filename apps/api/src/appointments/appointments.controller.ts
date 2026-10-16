import { appointmentSchema } from '@instafix/contracts';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { authenticated, checkOrigin } from '../auth/session';
import { db } from '../database/client';
import { normalizePhone } from '@instafix/contracts/src/phone';
import { cancelPendingJobs, lockAppointment, queueJob, queueReminders } from '../whatsapp/queue';
import { z } from 'zod';

@Controller('api/v1')
export class AppointmentsController {
  // La clasificación técnica es independiente de la descripción y del horario reservado.
  @Patch('admin/appointments/:id/service') async assignService(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    checkOrigin(req);
    await authenticated(req, true);
    const parsed = z
      .object({ offeringId: z.string().min(1).max(100) })
      .strict()
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException('Selecciona un servicio del catálogo');
    const offering = await db.offering.findUnique({ where: { id: parsed.data.offeringId } });
    if (!offering) throw new BadRequestException('Servicio no encontrado');
    return db.$transaction(async (tx) => {
      await lockAppointment(tx, id);
      const appointment = await tx.appointment.findUnique({
        where: { id },
        include: { completedJob: true },
      });
      if (!appointment || appointment.completedJob || appointment.status === 'CANCELLED')
        throw new BadRequestException('No se puede asignar un servicio a esta cita');
      return tx.appointment.update({
        where: { id },
        data: { offeringId: offering.id, device: offering.device },
      });
    });
  }

  @Get('admin/appointments') async adminAppointments(@Req() req: Request) {
    await authenticated(req, true);
    return db.appointment.findMany({
      orderBy: { startsAt: 'desc' },
      include: { user: { select: { name: true, phone: true } } },
    });
  }

  @Post('admin/appointments') async createAppointment(@Body() body: unknown, @Req() req: Request) {
    checkOrigin(req);
    await authenticated(req, true);
    const parsed = appointmentSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Revisa los datos y las fechas de la cita');
    const { whatsappConsent, ...data } = parsed.data;
    const user = data.userId ? await db.user.findUnique({ where: { id: data.userId } }) : null;
    if (data.userId && (!user || user.role !== 'CUSTOMER'))
      throw new BadRequestException('Selecciona un cliente');
    const contactName = data.contactName || user?.name || '';
    const contactPhone = normalizePhone(data.contactPhone || user?.phone || '', 'EC');
    if ((!contactName || !contactPhone) && (whatsappConsent || !data.userId))
      throw new BadRequestException('Revisa nombre y teléfono del invitado');
    return db.$transaction(async (tx) => {
      const appointment = await tx.appointment.create({
        data: {
          ...data,
          contactName,
          contactPhone: contactPhone || user?.phone || '',
          whatsappConsentAt: whatsappConsent ? new Date() : null,
        },
      });
      if (whatsappConsent) {
        if (appointment.status === 'PENDING_LOCATION')
          await queueJob(tx, appointment, 'INITIAL', new Date());
        await queueReminders(tx, appointment);
      }
      return appointment;
    });
  }

  @Patch('admin/appointments/:id') async editAppointment(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    checkOrigin(req);
    await authenticated(req, true);
    const parsed = appointmentSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Revisa los datos y las fechas de la cita');
    return db.$transaction(async (tx) => {
      await lockAppointment(tx, id);
      const existing = await tx.appointment.findUnique({ where: { id } });
      if (!existing || existing.userId !== parsed.data.userId)
        throw new BadRequestException('No se puede cambiar el propietario de una cita');
      const { whatsappConsent, ...data } = parsed.data;
      // Las reservas externas se cancelan/reprograman en Cal para conservar disponibilidad real.
      if (
        existing.calUid &&
        (new Date(data.startsAt).getTime() !== existing.startsAt.getTime() ||
          new Date(data.endsAt).getTime() !== existing.endsAt.getTime() ||
          data.status !== existing.status)
      )
        throw new BadRequestException(
          'Reprograma o cancela esta reserva desde Cal.com. La confirmación se realiza al recibir su ubicación.',
        );
      const phone =
        data.contactPhone === undefined
          ? existing.contactPhone
          : normalizePhone(data.contactPhone, 'EC');
      if (data.contactPhone !== undefined && !phone)
        throw new BadRequestException('Teléfono inválido');
      if (
        existing.calUid &&
        (phone !== existing.contactPhone ||
          data.title !== existing.title ||
          (data.contactName !== undefined && data.contactName !== existing.contactName))
      )
        throw new BadRequestException(
          'Edita los datos de contacto y el servicio de esta reserva desde Cal.com.',
        );
      const changed =
        new Date(data.startsAt).getTime() !== existing.startsAt.getTime() ||
        new Date(data.endsAt).getTime() !== existing.endsAt.getTime() ||
        data.timeZone !== existing.timeZone ||
        data.title !== existing.title ||
        phone !== existing.contactPhone ||
        (data.contactName !== undefined && data.contactName !== existing.contactName) ||
        data.status !== existing.status ||
        (whatsappConsent !== undefined && whatsappConsent !== Boolean(existing.whatsappConsentAt));
      if (changed) await cancelPendingJobs(tx, id);
      const appointment = await tx.appointment.update({
        where: { id },
        data: {
          ...data,
          contactPhone: phone || '',
          ...(changed
            ? {
                automationRevision: { increment: 1 },
                locationRequestedAt: new Date(),
                ...(data.status === 'PENDING_LOCATION'
                  ? { locationReceivedAt: null, locationLatitude: null, locationLongitude: null }
                  : {}),
              }
            : {}),
          ...(whatsappConsent !== undefined
            ? {
                whatsappConsentAt: whatsappConsent
                  ? existing.whatsappConsentAt || new Date()
                  : null,
              }
            : {}),
        },
      });
      if (changed && appointment.whatsappConsentAt) {
        if (appointment.status === 'PENDING_LOCATION' && !appointment.locationReceivedAt)
          await queueJob(tx, appointment, 'INITIAL', new Date());
        await queueReminders(tx, appointment);
      }
      return appointment;
    });
  }
}
