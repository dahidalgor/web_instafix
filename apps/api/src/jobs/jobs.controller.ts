import { BadRequestException, Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
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
  /**
   * Cuentas para administración. Con «q» busca en todas (no solo las 100 recientes): por nombre
   * sin distinguir tildes ni mayúsculas, o por cualquier parte del número (0991…, +593 99…).
   */
  @Get('admin/users') async users(
    @Req() req: Request,
    @Query('q') q?: string,
    @Query('role') role?: string,
  ) {
    await authenticated(req, true);
    const text = (q || '').trim().slice(0, 100);
    const digits = text.replace(/\D/g, '').replace(/^0/, '');
    const roleFilter = role === 'CUSTOMER' ? { role: 'CUSTOMER' as const } : {};
    if (!text)
      return db.user.findMany({
        where: { ...roleFilter, deletedAt: null },
        select: safeUser,
        orderBy: { createdAt: 'desc' },
        take: 100,
      });
    const ids = await db.$queryRaw<{ id: string }[]>`
      SELECT id FROM "User"
      WHERE "deletedAt" IS NULL
        AND (${role === 'CUSTOMER'} = false OR role = 'CUSTOMER')
        AND (
          translate(lower(name), 'áéíóúüñ', 'aeiouun') LIKE '%' || translate(lower(${text}), 'áéíóúüñ', 'aeiouun') || '%'
          OR (${digits.length >= 3} AND regexp_replace(phone, '[^0-9]', '', 'g') LIKE '%' || ${digits} || '%')
          OR lower(coalesce(email, '')) LIKE '%' || lower(${text}) || '%'
        )
      ORDER BY "createdAt" DESC
      LIMIT 20`;
    if (!ids.length) return [];
    return db.user.findMany({
      where: { id: { in: ids.map((row) => row.id) } },
      select: safeUser,
      orderBy: { name: 'asc' },
    });
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
      if (user?.role !== 'CUSTOMER' || user.deletedAt || !offering)
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
          appointment.status === 'CANCELLED' ||
          appointment.completedJob
        )
          throw new BadRequestException(
            'La cita no corresponde al cliente, está cancelada o ya tiene un trabajo registrado',
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
