import { BadRequestException } from '@nestjs/common';
import {
  busyBlockAt,
  busyBlockInputSchema,
  busyBlocksFromInput,
  type BusyBlock,
} from '@instafix/contracts';
import type { Prisma } from '@prisma/client';
import { db } from '../database/client';
import { dayIn } from '../integrations/cal-client';

/**
 * Disponibilidad de los técnicos: sus horarios ocupados (clases, otro trabajo…) y sus visitas
 * confirmadas. Decide qué horarios ofrece la web, a quién avisar de una solicitud y quién puede
 * confirmarla. Solo cuenta el rol TECHNICIAN; administración ve y puede confirmar todo.
 */
type Client = Prisma.TransactionClient | typeof db;
type Window = { startsAt: Date; endsAt: Date; id?: string };

const MAX_BLOCKS = 60;
export const OTHER_VISIT = 'otra visita confirmada';

/** Técnicos activos con sus horarios ocupados y sus visitas activas que tocan [from, to). */
export function technicianAgenda(client: Client, from: Date, to: Date, userId?: string) {
  return client.user.findMany({
    where: {
      role: 'TECHNICIAN',
      active: true,
      deletedAt: null,
      ...(userId ? { id: userId } : {}),
    },
    select: {
      id: true,
      name: true,
      busyBlocks: true,
      assignedAppointments: {
        where: {
          status: { in: ['CONFIRMED', 'IN_PROGRESS'] },
          deletedAt: null,
          startsAt: { lt: to },
          endsAt: { gt: from },
        },
        select: { id: true, startsAt: true, endsAt: true },
      },
    },
  });
}
export type TechnicianAgenda = Awaited<ReturnType<typeof technicianAgenda>>[number];

/** Por qué el técnico no puede atender ese horario (motivo del bloque u otra visita), o null. */
export function busyReason(tech: TechnicianAgenda, window: Window) {
  const block = busyBlockAt(tech.busyBlocks, window.startsAt, window.endsAt);
  if (block) return block.label;
  const visit = tech.assignedAppointments.find(
    (a) => a.id !== window.id && a.startsAt < window.endsAt && a.endsAt > window.startsAt,
  );
  return visit ? OTHER_VISIT : null;
}

/** Técnicos libres para esa cita. */
export async function availableTechnicianIds(client: Client, window: Window) {
  const agenda = await technicianAgenda(client, window.startsAt, window.endsAt);
  return agenda.filter((tech) => !busyReason(tech, window)).map((tech) => tech.id);
}

/**
 * Hay al menos un técnico libre. Sin ningún técnico registrado no se restringe nada (las
 * visitas las atiende administración y la agenda la marca Cal.com).
 */
export async function someTechnicianFree(client: Client, window: Window) {
  const agenda = await technicianAgenda(client, window.startsAt, window.endsAt);
  return !agenda.length || agenda.some((tech) => !busyReason(tech, window));
}

/** Motivo por el que ESTE técnico no puede atender la cita (null si puede o no es técnico). */
export async function technicianBusyReason(client: Client, userId: string, window: Window) {
  const [tech] = await technicianAgenda(client, window.startsAt, window.endsAt, userId);
  return tech ? busyReason(tech, window) : null;
}

const today = () => dayIn(new Date());
/** Vigentes: los de un día que aún no pasó y los semanales que no terminaron. */
const current = (block: Pick<BusyBlock, 'date' | 'validUntil'>, day = today()) =>
  block.date ? block.date >= day : !block.validUntil || block.validUntil >= day;

export async function listBusyBlocks(userId: string): Promise<BusyBlock[]> {
  const blocks = await db.technicianBusyBlock.findMany({
    where: { userId },
    orderBy: [{ date: 'asc' }, { weekday: 'asc' }, { startMinute: 'asc' }],
  });
  return blocks.filter((block) => current(block)).map(({ userId: _u, createdAt: _c, ...b }) => b);
}

/**
 * Guarda un horario ocupado (uno por día de la semana elegido). Devuelve cuántas visitas ya
 * confirmadas del técnico chocan con él: esas no cambian, pero el técnico debe avisar.
 */
export async function addBusyBlocks(userId: string, body: unknown) {
  const parsed = busyBlockInputSchema.safeParse(body);
  if (!parsed.success)
    throw new BadRequestException(parsed.error.issues[0]?.message || 'Revisa el horario');
  const day = today();
  if (parsed.data.repeat === 'ONCE' && parsed.data.date! < day)
    throw new BadRequestException('Elige un día de hoy en adelante.');
  if (parsed.data.validUntil && parsed.data.validUntil < day)
    throw new BadRequestException('La fecha «hasta» ya pasó.');
  const rows = busyBlocksFromInput(parsed.data, day);
  const existing = await db.technicianBusyBlock.count({ where: { userId } });
  if (existing + rows.length > MAX_BLOCKS)
    throw new BadRequestException('Tienes demasiados horarios: quita los que ya no usas.');
  await db.technicianBusyBlock.createMany({ data: rows.map((row) => ({ ...row, userId })) });
  // Visitas confirmadas por venir que caen en el horario nuevo.
  const visits = await db.appointment.findMany({
    where: {
      assignedTechnicianId: userId,
      status: { in: ['CONFIRMED', 'IN_PROGRESS'] },
      deletedAt: null,
      endsAt: { gt: new Date() },
    },
    select: { startsAt: true, endsAt: true },
  });
  const conflicts = visits.filter((visit) =>
    busyBlockAt(rows, visit.startsAt, visit.endsAt),
  ).length;
  return { blocks: await listBusyBlocks(userId), conflicts };
}

export async function removeBusyBlock(userId: string, id: string) {
  // Solo los propios: el id de otro técnico no borra nada.
  await db.technicianBusyBlock.deleteMany({ where: { id, userId } });
  return { blocks: await listBusyBlocks(userId) };
}
