import { recordMissingCompletedJobs } from '../jobs/completed-job';
import { Controller, Get, Header, Query, Req } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { authenticated } from '../auth/session';
import { pageParams } from '../common/pagination';
import { db } from '../database/client';
import { dayIn } from '../integrations/cal-client';

/** Citas que siguen por delante (ni canceladas ni completadas, y aún no terminan). */
const upcomingWhere = (userId: string, now: Date): Prisma.AppointmentWhereInput => ({
  userId,
  deletedAt: null,
  status: { notIn: ['CANCELLED', 'COMPLETED'] },
  endsAt: { gte: now },
});

const appointmentInclude = {
  offering: { select: { title: true, device: true } },
  assignedTechnician: { select: { name: true } },
  services: {
    orderBy: { createdAt: 'asc' as const },
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
} satisfies Prisma.AppointmentInclude;
type Row = Prisma.AppointmentGetPayload<{ include: typeof appointmentInclude }>;

/** Datos internos del equipo (notas técnicas, auditoría, incidencias) no salen al cliente. */
const forCustomer = ({
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
  handoverRequestedById: _handoverBy,
  handoverReason: _handoverReason,
  ...appointment
}: Row) => ({ ...appointment, assignedService: offering });

@Controller('api/v1')
export class AccountController {
  // El propietario se obtiene de la sesión, nunca de un teléfono o ID del navegador.

  /** Servicios realizados de la cuenta, del más reciente, por páginas. */
  @Get('my/jobs')
  @Header('Cache-Control', 'no-store')
  async jobs(@Req() req: Request, @Query('page') page = '1', @Query('pageSize') size = '10') {
    const user = await authenticated(req);
    // Citas completadas antes de registrar trabajos automáticamente.
    await recordMissingCompletedJobs(user.id);
    const { page: p, pageSize } = pageParams(page, size, 10, 50);
    const where = { userId: user.id };
    const [total, items] = await Promise.all([
      db.completedJob.count({ where }),
      db.completedJob.findMany({
        where,
        orderBy: [{ completedAt: 'desc' }, { id: 'asc' }],
        skip: (p - 1) * pageSize,
        take: pageSize,
        // Sorteo de cada trabajo: la cuenta muestra las participaciones mientras siga abierto.
        include: {
          giveaway: {
            select: { id: true, prize: true, drawDate: true, entryRule: true, closedAt: true },
          },
        },
      }),
    ]);
    return { total, page: p, pageSize, items };
  }

  /**
   * Citas de la cuenta. `scope=upcoming` (predeterminado): las que siguen por delante, todas
   * (son pocas). `scope=past`: el historial, de la más reciente, por páginas.
   */
  @Get('my/appointments')
  @Header('Cache-Control', 'no-store')
  async appointments(
    @Req() req: Request,
    @Query('scope') scope = 'upcoming',
    @Query('page') page = '1',
    @Query('pageSize') size = '10',
  ) {
    const user = await authenticated(req);
    const now = new Date();
    const upcoming = upcomingWhere(user.id, now);
    const past = scope === 'past';
    const { page: p, pageSize } = past ? pageParams(page, size, 10, 50) : { page: 1, pageSize: 50 };
    const where: Prisma.AppointmentWhereInput = past
      ? { userId: user.id, deletedAt: null, NOT: upcoming }
      : upcoming;
    const [total, items] = await Promise.all([
      db.appointment.count({ where }),
      db.appointment.findMany({
        where,
        orderBy: [{ startsAt: past ? 'desc' : 'asc' }, { id: 'asc' }],
        skip: (p - 1) * pageSize,
        take: pageSize,
        include: appointmentInclude,
      }),
    ]);
    return { total, page: p, pageSize, items: items.map(forCustomer) };
  }

  /** Números del encabezado de Mi cuenta y el sorteo abierto, sin traer el historial. */
  @Get('my/summary')
  @Header('Cache-Control', 'no-store')
  async summary(@Req() req: Request) {
    const user = await authenticated(req);
    await recordMissingCompletedJobs(user.id);
    const now = new Date();
    const [upcoming, jobs, visitsWithServices, warranties, entries] = await Promise.all([
      db.appointment.count({ where: upcomingWhere(user.id, now) }),
      db.completedJob.count({ where: { userId: user.id } }),
      // Visitas completadas con servicios que aún no tienen trabajo registrado.
      db.appointment.count({
        where: {
          userId: user.id,
          deletedAt: null,
          status: 'COMPLETED',
          services: { some: {} },
          completedJob: null,
        },
      }),
      db.completedJob.count({ where: { userId: user.id, warrantyEndsAt: { gt: now } } }),
      db.completedJob.groupBy({
        by: ['giveawayId'],
        where: {
          userId: user.id,
          giveawayEntries: { gt: 0 },
          giveaway: { closedAt: null, drawDate: { gte: dayIn(now) } },
        },
        _sum: { giveawayEntries: true },
      }),
    ]);
    const open = entries.find((e) => e.giveawayId);
    const giveaway = open
      ? await db.giveaway.findUnique({
          where: { id: open.giveawayId! },
          select: { id: true, prize: true, drawDate: true, entryRule: true },
        })
      : null;
    return {
      upcoming,
      servicesDone: jobs + visitsWithServices,
      activeWarranties: warranties,
      giveaway: giveaway ? { ...giveaway, entries: open!._sum.giveawayEntries ?? 0 } : null,
    };
  }
}
