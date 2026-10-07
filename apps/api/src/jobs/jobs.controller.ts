import { BadRequestException, Body, Controller, Get, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { authenticated, checkOrigin, safeUser } from '../auth/session';
import { db } from '../database/client';

@Controller('api/v1')
export class JobsController {
  @Get('admin/users') async users(@Req() req: Request) {
    await authenticated(req, true);
    return db.user.findMany({ select: safeUser, orderBy: { createdAt: 'desc' }, take: 100 });
  }

  @Post('admin/jobs') async addJob(@Body() body: any, @Req() req: Request) {
    checkOrigin(req);
    await authenticated(req, true);
    if (
      typeof body.userId !== 'string' ||
      typeof body.title !== 'string' ||
      body.title.length < 3 ||
      body.title.length > 150 ||
      typeof body.device !== 'string' ||
      body.device.length > 100 ||
      typeof body.warrantyTerms !== 'string' ||
      body.warrantyTerms.length > 5000 ||
      !Number.isInteger(body.priceMinor) ||
      body.priceMinor < 0 ||
      body.priceMinor > 10000000
    )
      throw new BadRequestException('Datos de trabajo no válidos');
    const completedAt = new Date(body.completedAt);
    const warrantyEndsAt = body.warrantyEndsAt ? new Date(body.warrantyEndsAt) : null;
    if (
      !Number.isFinite(completedAt.getTime()) ||
      completedAt > new Date() ||
      (warrantyEndsAt &&
        (!Number.isFinite(warrantyEndsAt.getTime()) || warrantyEndsAt < completedAt))
    )
      throw new BadRequestException('Revisa las fechas');
    const user = await db.user.findUnique({ where: { id: body.userId } });
    if (!user) throw new BadRequestException('Cliente no encontrado');
    return db.completedJob.create({
      data: {
        userId: user.id,
        title: body.title,
        device: body.device,
        warrantyTerms: body.warrantyTerms,
        priceMinor: body.priceMinor,
        completedAt,
        warrantyEndsAt,
      },
    });
  }
}
