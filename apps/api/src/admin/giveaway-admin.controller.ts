import { giveaway, giveawayOpen } from '@instafix/contracts';
import { normalizePhone } from '@instafix/contracts/src/phone';
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Header,
  NotFoundException,
  Patch,
  Param,
  Query,
  Req,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { z } from 'zod';
import { authenticated, checkOrigin } from '../auth/session';
import { db } from '../database/client';
import { auditAdmin } from '../security/admin-audit';
import { RateLimit } from '../security/rate-limits';
import { lockAppointment } from '../whatsapp/queue';

const visitFields = {
  id: true,
  contactName: true,
  contactPhone: true,
  title: true,
  completedAt: true,
  giveawayEntries: true,
  user: { select: { id: true, name: true, phone: true, deletedAt: true } },
  completedBy: { select: { name: true } },
  services: { select: { nameSnapshot: true, deviceSnapshot: true, quantity: true } },
} satisfies Prisma.AppointmentSelect;
type Visit = Prisma.AppointmentGetPayload<{ select: typeof visitFields }>;

const entriesSchema = z
  .object({ giveawayEntries: z.number().int().min(0).max(giveaway.maxEntries) })
  .strict();

/** Persona del sorteo: la cuenta del cliente o, si es invitado, su teléfono. */
function participantKey(v: Visit) {
  if (v.user && !v.user.deletedAt) return `user:${v.user.id}`;
  return `phone:${normalizePhone(v.contactPhone, 'EC') ?? v.contactPhone}`;
}
const visitView = (v: Visit) => ({
  id: v.id,
  completedAt: v.completedAt?.toISOString() ?? null,
  title: v.title,
  services: v.services.map((s) =>
    s.quantity > 1 ? `${s.nameSnapshot} ×${s.quantity}` : s.nameSnapshot,
  ),
  technician: v.completedBy?.name ?? null,
  giveawayEntries: v.giveawayEntries,
  contactName: (v.user && !v.user.deletedAt ? v.user.name : v.contactName) || 'Cliente',
  contactPhone: (v.user && !v.user.deletedAt ? v.user.phone : v.contactPhone) || '',
});

/** Sorteo vigente (solo ADMIN): participantes y corrección de participaciones por visita. */
@Controller('api/v1/admin/giveaway')
export class GiveawayAdminController {
  /** Participantes agrupados por persona, con sus visitas. */
  @Get()
  @Header('Cache-Control', 'no-store')
  @RateLimit('staff')
  async participants(@Req() req: Request) {
    await authenticated(req, true);
    const visits = await db.appointment.findMany({
      where: { status: 'COMPLETED', deletedAt: null, giveawayEntries: { gt: 0 } },
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
      const view = visitView(visit);
      const key = participantKey(visit);
      const person = people.get(key) ?? {
        key,
        name: view.contactName,
        phone: view.contactPhone,
        entries: 0,
        visits: [],
      };
      person.entries += visit.giveawayEntries;
      person.visits.push(view);
      people.set(key, person);
    }
    const participants = [...people.values()].sort(
      (a, b) => b.entries - a.entries || a.name.localeCompare(b.name, 'es'),
    );
    return {
      prize: giveaway.prize,
      drawDate: giveaway.drawDate,
      open: giveawayOpen(),
      maxEntries: giveaway.maxEntries,
      totalEntries: participants.reduce((sum, p) => sum + p.entries, 0),
      participants,
    };
  }

  /** Visitas completadas (con o sin participaciones) para corregir: búsqueda por nombre o teléfono. */
  @Get('visits')
  @Header('Cache-Control', 'no-store')
  @RateLimit('staff')
  async visits(@Req() req: Request, @Query('q') q = '') {
    await authenticated(req, true);
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
    return visits.map(visitView);
  }

  /**
   * Corrige las participaciones de una visita completada (p. ej. el técnico olvidó marcarla).
   * Se actualizan la cita y el trabajo del cliente. Cerrado el sorteo no se modifica nada.
   */
  @Patch('visits/:id')
  @RateLimit('staff')
  async correct(@Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    checkOrigin(req);
    const admin = await authenticated(req, true);
    const parsed = entriesSchema.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException(`Indica entre 0 y ${giveaway.maxEntries} participaciones.`);
    if (!giveawayOpen())
      throw new ConflictException(
        `El sorteo de ${giveaway.prize} ya cerró: las participaciones no se pueden cambiar.`,
      );
    const entries = parsed.data.giveawayEntries;
    return db.$transaction(async (tx) => {
      await lockAppointment(tx, id);
      const visit = await tx.appointment.findFirst({
        where: { id, deletedAt: null },
        select: { status: true, giveawayEntries: true },
      });
      if (!visit) throw new NotFoundException('Visita no encontrada');
      if (visit.status !== 'COMPLETED')
        throw new ConflictException(
          'Solo se corrigen visitas completadas; las demás se marcan al completarlas.',
        );
      if (visit.giveawayEntries !== entries) {
        await tx.appointment.update({ where: { id }, data: { giveawayEntries: entries } });
        await tx.completedJob.updateMany({
          where: { appointmentId: id },
          data: { giveawayEntries: entries },
        });
        await tx.appointmentActivity.create({
          data: {
            appointmentId: id,
            actorId: admin.id,
            action: 'GIVEAWAY_UPDATED',
            detail: { from: visit.giveawayEntries, to: entries },
          },
        });
        await auditAdmin(
          admin.id,
          'GIVEAWAY_UPDATED',
          id,
          { from: visit.giveawayEntries, to: entries },
          tx,
        );
      }
      const updated = await tx.appointment.findUniqueOrThrow({
        where: { id },
        select: visitFields,
      });
      return visitView(updated);
    });
  }
}
