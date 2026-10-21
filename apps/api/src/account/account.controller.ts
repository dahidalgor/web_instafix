import { recordMissingCompletedJobs } from '../jobs/completed-job';
import { Controller, Get, Req } from '@nestjs/common';
import type { Request } from 'express';
import { authenticated } from '../auth/session';
import { db } from '../database/client';

@Controller('api/v1')
export class AccountController {
  // El propietario se obtiene de la sesión, nunca de un teléfono o ID del navegador.
  @Get('my/jobs') async jobs(@Req() req: Request) {
    const user = await authenticated(req);
    // Citas completadas antes de registrar trabajos automáticamente.
    await recordMissingCompletedJobs(user.id);
    return db.completedJob.findMany({
      where: { userId: user.id },
      orderBy: { completedAt: 'desc' },
    });
  }

  @Get('my/appointments') async appointments(@Req() req: Request) {
    const user = await authenticated(req);
    const appointments = await db.appointment.findMany({
      where: { userId: user.id, deletedAt: null },
      orderBy: { startsAt: 'asc' },
      include: {
        offering: { select: { title: true, device: true } },
        assignedTechnician: { select: { name: true } },
        services: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            offeringId: true,
            nameSnapshot: true,
            deviceSnapshot: true,
            unitPriceMinor: true,
            quantity: true,
            totalMinor: true,
            currency: true,
            warrantyDaysSnapshot: true,
          },
        },
      },
    });
    // Datos internos del equipo (notas técnicas, auditoría, incidencias) no salen al cliente.
    return appointments.map(
      ({
        offering,
        technicianNotes: _notes,
        confirmedById: _confirmedBy,
        completedById: _completedBy,
        assignedTechnicianId: _technicianId,
        automationIssue: _issue,
        automationRevision: _revision,
        originSessionKey: _session,
        originIpHash: _ip,
        deletedAt: _deletedAt,
        deletedById: _deletedBy,
        ...appointment
      }) => ({ ...appointment, assignedService: offering }),
    );
  }
}
