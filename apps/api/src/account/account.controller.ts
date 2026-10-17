import { Controller, Get, Req } from '@nestjs/common';
import type { Request } from 'express';
import { authenticated } from '../auth/session';
import { db } from '../database/client';

@Controller('api/v1')
export class AccountController {
  // El propietario se obtiene de la sesión, nunca de un teléfono o ID del navegador.
  @Get('my/jobs') async jobs(@Req() req: Request) {
    const user = await authenticated(req);
    return db.completedJob.findMany({
      where: { userId: user.id },
      orderBy: { completedAt: 'desc' },
    });
  }

  // Compatibilidad: la web usa GET /appointments/me (próximas e historial separados).
  @Get('my/appointments') async appointments(@Req() req: Request) {
    const user = await authenticated(req);
    const appointments = await db.appointment.findMany({
      where: { userId: user.id, status: { not: 'FAILED' } },
      orderBy: { startsAt: 'asc' },
      include: { offering: { select: { title: true, device: true } } },
    });
    return appointments.map(({ offering, ...appointment }) => ({
      ...appointment,
      assignedService: offering,
    }));
  }
}
