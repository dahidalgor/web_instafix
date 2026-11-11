import {
  giveawayEntriesSchema,
  giveawayInputSchema,
  giveawayIsOpen,
  type Giveaway as GiveawayView,
} from '@instafix/contracts';
import { normalizePhone } from '@instafix/contracts/src/phone';
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Header,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { authenticated, checkOrigin } from '../auth/session';
import { db } from '../database/client';
import { dayIn } from '../integrations/cal-client';
import { auditAdmin } from '../security/admin-audit';
import { RateLimit } from '../security/rate-limits';
import { lockAppointment } from '../whatsapp/queue';
import { giveawayView, openGiveaway } from './giveaways';

const visitFields = {
  id: true,
  contactName: true,
  contactPhone: true,
  title: true,
  completedAt: true,
  giveawayId: true,
  giveawayEntries: true,
  user: { select: { id: true, name: true, phone: true, deletedAt: true } },
  completedBy: { select: { name: true } },
  services: { select: { nameSnapshot: true, quantity: true } },
} satisfies Prisma.AppointmentSelect;
type Visit = Prisma.AppointmentGetPayload<{ select: typeof visitFields }>;

/** Persona del sorteo: la cuenta del cliente o, si es invitado, su teléfono. */
function participantKey(v: Visit) {
  if (v.user && !v.user.deletedAt) return `user:${v.user.id}`;
  return `phone:${normalizePhone(v.contactPhone, 'EC') ?? v.contactPhone}`;
}
/** Una visita vista desde un sorteo: sus participaciones solo cuentan si son de ese sorteo. */
const visitView = (v: Visit, giveawayId: string) => ({
  id: v.id,
  completedAt: v.completedAt?.toISOString() ?? null,
  title: v.title,
  services: v.services.map((s) =>
    s.quantity > 1 ? `${s.nameSnapshot} ×${s.quantity}` : s.nameSnapshot,
  ),
  technician: v.completedBy?.name ?? null,
  giveawayEntries: v.giveawayId === giveawayId ? v.giveawayEntries : 0,
  /** Ya participa en otro sorteo: no se puede sumar a este. */
  otherGiveaway: v.giveawayId !== null && v.giveawayId !== giveawayId && v.giveawayEntries > 0,
  contactName: (v.user && !v.user.deletedAt ? v.user.name : v.contactName) || 'Cliente',
  contactPhone: (v.user && !v.user.deletedAt ? v.user.phone : v.contactPhone) || '',
});

const summary = (g: GiveawayView, entries: number, people: number) => ({
  ...g,
  open: giveawayIsOpen(g),
  totalEntries: entries,
  participants: people,
});

/** Sorteos (solo ADMIN): crear, cerrar, ver participantes y corregir participaciones. */
@Controller('api/v1/admin/giveaways')
export class GiveawayAdminController {
  private async find(id: string) {
    const giveaway = await db.giveaway.findUnique({ where: { id } });
    if (!giveaway) throw new NotFoundException('Sorteo no encontrado');
    return giveaway;
  }

  /** Todos los sorteos, el más reciente primero, con sus totales. */
  @Get()
  @Header('Cache-Control', 'no-store')
  @RateLimit('staff')
  async list(@Req() req: Request) {
    await authenticated(req, true);
    const [giveaways, totals] = await Promise.all([
      db.giveaway.findMany({ orderBy: { createdAt: 'desc' } }),
      db.appointment.groupBy({
        by: ['giveawayId'],
        where: { status: 'COMPLETED', deletedAt: null, giveawayEntries: { gt: 0 } },
        _sum: { giveawayEntries: true },
        _count: true,
      }),
    ]);
    return giveaways.map((g) => {
      const total = totals.find((t) => t.giveawayId === g.id);
      return summary(giveawayView(g), total?._sum.giveawayEntries ?? 0, total?._count ?? 0);
    });
  }

  /** Nuevo sorteo. Solo uno abierto a la vez: cierra el anterior antes de crear otro. */
  @Post()
  @HttpCode(201)
  @RateLimit('staff')
  async create(@Body() body: unknown, @Req() req: Request) {
    checkOrigin(req);
    const admin = await authenticated(req, true);
    const parsed = giveawayInputSchema.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException(parsed.error.issues[0]?.message || 'Revisa el sorteo');
    if (parsed.data.drawDate < dayIn(new Date()))
      throw new BadRequestException('El día del sorteo ya pasó.');
    const offerings = await db.offering.count({
      where: { id: { in: parsed.data.eligibleOfferingIds } },
    });
    if (offerings !== new Set(parsed.data.eligibleOfferingIds).size)
      throw new BadRequestException('Algún servicio elegido ya no existe en el catálogo.');
    const created = await db.$transaction(async (tx) => {
      // Ordena dos altas simultáneas: nunca quedan dos sorteos abiertos.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('giveaways'))`;
      const current = await openGiveaway(tx);
      if (current)
        throw new ConflictException(
          `Ya hay un sorteo abierto (${current.prize}). Ciérralo antes de crear otro.`,
        );
      const giveaway = await tx.giveaway.create({
        data: {
          ...parsed.data,
          eligibleOfferingIds: [...new Set(parsed.data.eligibleOfferingIds)],
          createdById: admin.id,
        },
      });
      await auditAdmin(admin.id, 'GIVEAWAY_CREATED', giveaway.id, { prize: giveaway.prize }, tx);
      return giveaway;
    });
    return summary(giveawayView(created), 0, 0);
  }

  /** Cierra el sorteo: deja de admitir participaciones. Las ya registradas se conservan. */
  @Post(':id/close')
  @HttpCode(200)
  @RateLimit('staff')
  async close(@Param('id') id: string, @Req() req: Request) {
    checkOrigin(req);
    const admin = await authenticated(req, true);
    await this.find(id);
    const closed = await db.giveaway.updateMany({
      where: { id, closedAt: null },
      data: { closedAt: new Date(), closedById: admin.id },
    });
    if (closed.count) await auditAdmin(admin.id, 'GIVEAWAY_CLOSED', id, {});
    return this.participants(id, req);
  }

  /** Participantes del sorteo agrupados por persona, con sus visitas. */
  @Get(':id')
  @Header('Cache-Control', 'no-store')
  @RateLimit('staff')
  async participants(@Param('id') id: string, @Req() req: Request) {
    await authenticated(req, true);
    const giveaway = giveawayView(await this.find(id));
    const visits = await db.appointment.findMany({
      where: { giveawayId: id, status: 'COMPLETED', deletedAt: null, giveawayEntries: { gt: 0 } },
      select: visitFields,
      orderBy: { completedAt: 'asc' },
    });
    const people = new Map<
      string,
      {
        key: string;
        name: string;
        phone: string;
        entries: number;
        visits: ReturnType<typeof visitView>[];
      }
    >();
    for (const visit of visits) {
      const view = visitView(visit, id);
      const key = participantKey(visit);
      const person = people.get(key) ?? {
        key,
        name: view.contactName,
        phone: view.contactPhone,
        entries: 0,
        visits: [],
      };
      person.entries += view.giveawayEntries;
      person.visits.push(view);
      people.set(key, person);
    }
    const participants = [...people.values()].sort(
      (a, b) => b.entries - a.entries || a.name.localeCompare(b.name, 'es'),
    );
    return {
      ...summary(
        giveaway,
        participants.reduce((sum, p) => sum + p.entries, 0),
        participants.length,
      ),
      people: participants,
    };
  }

  /** Visitas completadas para corregir: búsqueda por nombre o teléfono del cliente. */
  @Get(':id/visits')
  @Header('Cache-Control', 'no-store')
  @RateLimit('staff')
  async visits(@Param('id') id: string, @Req() req: Request, @Query('q') q = '') {
    await authenticated(req, true);
    await this.find(id);
    const text = q.trim().slice(0, 100);
    if (text.length < 2) return [];
    const digits = text.replace(/\D/g, '').replace(/^0/, '');
    const visits = await db.appointment.findMany({
      where: {
        status: 'COMPLETED',
        deletedAt: null,
        OR: [
          { contactName: { contains: text, mode: 'insensitive' } },
          { user: { name: { contains: text, mode: 'insensitive' } } },
          ...(digits.length >= 4
            ? [{ contactPhone: { contains: digits } }, { user: { phone: { contains: digits } } }]
            : []),
        ],
      },
      select: visitFields,
      orderBy: { completedAt: 'desc' },
      take: 20,
    });
    return visits.map((v) => visitView(v, id));
  }

  /**
   * Corrige las participaciones de una visita completada (p. ej. el técnico olvidó marcarla).
   * Se actualizan la cita y el trabajo del cliente. Solo con el sorteo abierto, y nunca una
   * visita que ya participa en otro sorteo.
   */
  @Patch(':id/visits/:visitId')
  @RateLimit('staff')
  async correct(
    @Param('id') id: string,
    @Param('visitId') visitId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    checkOrigin(req);
    const admin = await authenticated(req, true);
    const giveaway = await this.find(id);
    const parsed = giveawayEntriesSchema.safeParse(body);
    if (!parsed.success || parsed.data.giveawayEntries > giveaway.maxEntries)
      throw new BadRequestException(`Indica entre 0 y ${giveaway.maxEntries} participaciones.`);
    if (!giveawayIsOpen(giveaway))
      throw new ConflictException(
        `El sorteo de ${giveaway.prize} ya cerró: las participaciones no se pueden cambiar.`,
      );
    const entries = parsed.data.giveawayEntries;
    return db.$transaction(async (tx) => {
      await lockAppointment(tx, visitId);
      const visit = await tx.appointment.findFirst({
        where: { id: visitId, deletedAt: null },
        select: { status: true, giveawayId: true, giveawayEntries: true },
      });
      if (!visit) throw new NotFoundException('Visita no encontrada');
      if (visit.status !== 'COMPLETED')
        throw new ConflictException(
          'Solo se corrigen visitas completadas; las demás se marcan al completarlas.',
        );
      if (visit.giveawayId && visit.giveawayId !== id && visit.giveawayEntries > 0)
        throw new ConflictException('Esta visita ya participa en otro sorteo.');
      const before = visit.giveawayId === id ? visit.giveawayEntries : 0;
      if (before !== entries) {
        const data = { giveawayId: entries > 0 ? id : null, giveawayEntries: entries };
        await tx.appointment.update({ where: { id: visitId }, data });
        await tx.completedJob.updateMany({ where: { appointmentId: visitId }, data });
        const detail = { giveawayId: id, from: before, to: entries };
        await tx.appointmentActivity.create({
          data: { appointmentId: visitId, actorId: admin.id, action: 'GIVEAWAY_UPDATED', detail },
        });
        await auditAdmin(admin.id, 'GIVEAWAY_UPDATED', visitId, detail, tx);
      }
      const updated = await tx.appointment.findUniqueOrThrow({
        where: { id: visitId },
        select: visitFields,
      });
      return visitView(updated, id);
    });
  }
}
