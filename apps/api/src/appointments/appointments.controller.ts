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

@Controller('api/v1')
export class AppointmentsController {
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
    const user = await db.user.findUnique({ where: { id: parsed.data.userId } });
    if (!user || user.role !== 'CUSTOMER') throw new BadRequestException('Selecciona un cliente');
    return db.appointment.create({ data: parsed.data });
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
    const existing = await db.appointment.findUnique({ where: { id } });
    if (!existing || existing.userId !== parsed.data.userId)
      throw new BadRequestException('No se puede cambiar el propietario de una cita');
    return db.appointment.update({ where: { id }, data: parsed.data });
  }
}
