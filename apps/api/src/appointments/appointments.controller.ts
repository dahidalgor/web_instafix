import {
  appointmentSchema,
  appointmentSortSchema,
  type AppointmentSort,
} from '@instafix/contracts';
import type { Prisma } from '@prisma/client';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { authenticated, checkOrigin } from '../auth/session';
import { db } from '../database/client';
import { normalizePhone } from '@instafix/contracts/src/phone';
import { cancelPendingJobs, lockAppointment, queueJob, queueReminders } from '../whatsapp/queue';
import { z } from 'zod';
import { cancelCalBooking } from '../integrations/cal-client';
import { auditAdmin } from '../security/admin-audit';
import { exclusive } from '../security/idempotency';

/** createdAt = alta de la cita en Instafix; startsAt = inicio de la visita. Desempate por id. */
export function appointmentOrder(
  sort: AppointmentSort,
): Prisma.AppointmentOrderByWithRelationInput[] {
  const [field, direction] = {
    created_desc: ['createdAt', 'desc'],
    created_asc: ['createdAt', 'asc'],
    starts_asc: ['startsAt', 'asc'],
    starts_desc: ['startsAt', 'desc'],
  }[sort] as ['createdAt' | 'startsAt', 'asc' | 'desc'];
  return [{ [field]: direction }, { id: 'asc' }];
}

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
      if (
        !appointment ||
        appointment.deletedAt ||
        appointment.completedJob ||
        appointment.status === 'CANCELLED'
      )
        throw new BadRequestException('No se puede asignar un servicio a esta cita');
      return tx.appointment.update({
        where: { id },
        data: { offeringId: offering.id, device: offering.device },
      });
    });
  }

  @Get('admin/appointments') async adminAppointments(
    @Req() req: Request,
    @Query('sort') sortParam?: string,
  ) {
    await authenticated(req, true);
    const sort = appointmentSortSchema.safeParse(sortParam ?? undefined);
    if (!sort.success) throw new BadRequestException('Orden no válido');
    return db.appointment.findMany({
      where: { deletedAt: null },
      // El orden se resuelve en PostgreSQL sobre campos reales, nunca sobre texto formateado.
      orderBy: appointmentOrder(sort.data),
      include: {
        user: { select: { name: true, phone: true } },
        assignedTechnician: { select: { id: true, name: true, active: true } },
        services: { orderBy: { createdAt: 'asc' } },
      },
    });
  }

  @Post('admin/appointments') async createAppointment(@Body() body: unknown, @Req() req: Request) {
    checkOrigin(req);
    await authenticated(req, true);
    const parsed = appointmentSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Revisa los datos y las fechas de la cita');
    const { whatsappConsent, ...data } = parsed.data;
    const user = data.userId ? await db.user.findUnique({ where: { id: data.userId } }) : null;
    if (data.userId && (!user || user.role !== 'CUSTOMER' || user.deletedAt))
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
      if (!existing || existing.deletedAt || existing.userId !== parsed.data.userId)
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
      // Cambio real de fecha/hora = reprogramación (cuenta para el historial; el administrador
      // no está limitado). Notas, técnico o datos internos no la incrementan.
      const moved =
        new Date(data.startsAt).getTime() !== existing.startsAt.getTime() ||
        new Date(data.endsAt).getTime() !== existing.endsAt.getTime();
      // La ubicación recibida pertenece al cliente: solo se descarta si cambia su teléfono.
      const phoneChanged = phone !== existing.contactPhone;
      const appointment = await tx.appointment.update({
        where: { id },
        data: {
          ...data,
          // Con un técnico asignado desde su panel, el nombre visible lo define la asignación.
          technician: existing.assignedTechnicianId ? existing.technician : data.technician,
          contactPhone: phone || '',
          ...(changed
            ? {
                automationRevision: { increment: 1 },
                ...(moved ? { rescheduleCount: { increment: 1 } } : {}),
                ...(phoneChanged
                  ? {
                      locationRequestedAt: new Date(),
                      locationReceivedAt: null,
                      locationLatitude: null,
                      locationLongitude: null,
                      locationArea: null,
                      locationSource: null,
                      locationName: null,
                    }
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

  /**
   * Eliminar ≠ cancelar. Eliminar es administrativo (pruebas, spam, duplicados): la cita deja de
   * mostrarse en todos los paneles, sin avisar al cliente, y conserva su historial (deletedAt).
   * Si seguía activa en Cal.com, se libera el horario. Requiere confirmación explícita.
   */
  @Delete('admin/appointments/:id') async deleteAppointment(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    checkOrigin(req);
    const admin = await authenticated(req, true);
    if (
      !z
        .object({ confirm: z.literal(true) })
        .strict()
        .safeParse(body).success
    )
      throw new BadRequestException('Confirma la eliminación de la cita.');
    return exclusive(`appointment:${id}`, async () => {
      const current = await db.appointment.findUnique({ where: { id } });
      if (!current || current.deletedAt) throw new NotFoundException('Cita no encontrada');
      const active = ['PENDING_LOCATION', 'CONFIRMED', 'IN_PROGRESS'].includes(current.status);
      let calReleased = false;
      if (active && current.calUid && current.startsAt > new Date()) {
        // Sin liberar el horario en Cal.com quedaría ocupado para siempre.
        await cancelCalBooking(current.calUid, 'Eliminada por administración en Instafix');
        calReleased = true;
      }
      await db.$transaction(async (tx) => {
        await lockAppointment(tx, id);
        await tx.appointment.update({
          where: { id },
          data: {
            deletedAt: new Date(),
            deletedById: admin.id,
            automationRevision: { increment: 1 },
            ...(calReleased ? { calStatus: 'cancelled' } : {}),
          },
        });
        // Ningún aviso pendiente sale para una cita eliminada.
        await cancelPendingJobs(tx, id);
        await tx.notification.updateMany({
          where: { appointmentId: id, status: { in: ['PENDING', 'RETRY'] } },
          data: { status: 'CANCELLED' },
        });
        await tx.appointmentActivity.create({
          data: {
            appointmentId: id,
            actorId: admin.id,
            action: 'DELETED',
            detail: { previousStatus: current.status, calReleased },
          },
        });
        await auditAdmin(admin.id, 'APPOINTMENT_DELETED', id, { status: current.status }, tx);
      });
      return { ok: true, calReleased };
    });
  }
}
