import { BadRequestException, Body, Controller, Get, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { authenticated, checkOrigin, safeUser } from '../auth/session';
import { db } from '../database/client';
import { cancelPendingJobs, lockAppointment } from '../whatsapp/queue';

const jobSchema = z
  .object({
    userId: z.string().uuid(),
    offeringId: z.string().min(1).max(100),
    appointmentId: z.string().uuid().nullable().optional(),
    priceMinor: z.number().int().min(0).max(10000000),
    completedAt: z.string().datetime({ offset: true }),
    warrantyEndsAt: z.string().datetime({ offset: true }).nullable(),
    warrantyTerms: z.string().trim().min(1).max(5000),
  })
  .strict();

@Controller('api/v1')
export class JobsController {
  @Get('admin/users') async users(@Req() req: Request) {
    await authenticated(req, true);
    return db.user.findMany({ select: safeUser, orderBy: { createdAt: 'desc' }, take: 100 });
  }

  @Post('admin/jobs') async addJob(@Body() body: unknown, @Req() req: Request) {
    checkOrigin(req);
    await authenticated(req, true);
    const parsed = jobSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Revisa cliente, servicio, precio y fechas');
    const data = parsed.data;
    const completedAt = new Date(data.completedAt);
    const warrantyEndsAt = data.warrantyEndsAt ? new Date(data.warrantyEndsAt) : null;
    if (completedAt > new Date() || (warrantyEndsAt && warrantyEndsAt < completedAt))
      throw new BadRequestException('Revisa las fechas');
    return db.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: data.userId } });
      const offering = await tx.offering.findUnique({ where: { id: data.offeringId } });
      if (user?.role !== 'CUSTOMER' || !offering)
        throw new BadRequestException('Cliente o servicio no encontrado');
      if (data.appointmentId) {
        await lockAppointment(tx, data.appointmentId);
        const appointment = await tx.appointment.findUnique({
          where: { id: data.appointmentId },
          include: { completedJob: true },
        });
        if (
          !appointment ||
          appointment.userId !== user.id ||
          ['CANCELLED', 'FAILED', 'CREATING', 'RESCHEDULED'].includes(appointment.status) ||
          appointment.completedJob
        )
          throw new BadRequestException(
            'La cita no corresponde al cliente, no está activa o ya tiene un trabajo registrado',
          );
        await tx.appointment.update({
          where: { id: appointment.id },
          data: { status: 'COMPLETED', offeringId: offering.id, device: offering.device },
        });
        await cancelPendingJobs(tx, appointment.id);
      }
      // Se conserva una instantánea: cambiar el catálogo no altera precios ni garantías anteriores.
      return tx.completedJob.create({
        data: {
          userId: user.id,
          offeringId: offering.id,
          appointmentId: data.appointmentId,
          title: offering.title,
          device: offering.device,
          currency: offering.currency,
          warrantyTerms: data.warrantyTerms,
          priceMinor: data.priceMinor,
          completedAt,
          warrantyEndsAt,
        },
      });
    });
  }
}
