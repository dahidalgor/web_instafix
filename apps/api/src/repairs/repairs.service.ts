import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  customerFirstName,
  repairCode,
  repairInShop,
  type RepairOrderView,
  type RepairStatus,
} from '@instafix/contracts';
import type { Appointment, Prisma, RepairOrder } from '@prisma/client';
import type { StaffUser } from '../auth/session';
import { logEvent } from '../common/log-event';
import { db } from '../database/client';
import { dayIn } from '../integrations/cal-client';
import { enqueueStaffMessage } from '../notifications/staff/staff-notifications';
import { lockAppointment } from '../whatsapp/queue';

const DAY = 86400000;
/** El técnico puede registrar equipos hasta 24 h después de completar la visita. */
const INTAKE_AFTER_COMPLETION_MS = DAY;
/** El presupuesto por WhatsApp espera la respuesta hasta 3 días. */
const QUOTE_ANSWER_MS = 3 * DAY;

type Loaded = RepairOrder & {
  appointment: Pick<Appointment, 'startsAt' | 'contactName' | 'contactPhone'>;
  receivedBy: { name: string } | null;
};
const include = {
  appointment: { select: { startsAt: true, contactName: true, contactPhone: true } },
  receivedBy: { select: { name: true } },
} satisfies Prisma.RepairOrderInclude;

export function serializeRepair(order: Loaded, admin = false): RepairOrderView {
  return {
    id: order.id,
    code: repairCode(order.code),
    appointmentId: order.appointmentId,
    visitStartsAt: order.appointment.startsAt.toISOString(),
    device: order.device,
    reportedFault: order.reportedFault,
    intakeCondition: order.intakeCondition,
    status: order.status as RepairStatus,
    quoteMinor: order.quoteMinor,
    quoteNote: order.quoteNote,
    quotedAt: order.quotedAt?.toISOString() ?? null,
    quoteAnswer: (order.quoteAnswer as RepairOrderView['quoteAnswer']) ?? null,
    quoteAnsweredVia: (order.quoteAnsweredVia as RepairOrderView['quoteAnsweredVia']) ?? null,
    finalMinor: order.finalMinor,
    deliveredAt: order.deliveredAt?.toISOString() ?? null,
    createdAt: order.createdAt.toISOString(),
    receivedBy: order.receivedBy?.name ?? null,
    ...(admin
      ? { contactName: order.appointment.contactName, contactPhone: order.appointment.contactPhone }
      : {}),
  };
}

async function activity(
  tx: Prisma.TransactionClient,
  order: RepairOrder,
  actorId: string | null,
  action: string,
  detail: Record<string, unknown> = {},
) {
  await tx.appointmentActivity.create({
    data: {
      appointmentId: order.appointmentId,
      actorId,
      action,
      detail: { repairOrderId: order.id, code: repairCode(order.code), ...detail },
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Técnico: registra los equipos que se lleva desde su visita (solo el técnico a cargo).
// ---------------------------------------------------------------------------------------------

export async function createRepair(
  user: StaffUser,
  appointmentId: string,
  input: { device: string; reportedFault: string; intakeCondition: string },
  now = new Date(),
) {
  return db.$transaction(async (tx) => {
    await lockAppointment(tx, appointmentId);
    const a = await tx.appointment.findUnique({ where: { id: appointmentId } });
    if (!a || a.deletedAt) throw new NotFoundException('Cita no encontrada');
    if (a.assignedTechnicianId !== user.id)
      throw new ForbiddenException('Solo el técnico a cargo de la visita registra equipos.');
    const open = ['CONFIRMED', 'IN_PROGRESS'].includes(a.status);
    const justCompleted =
      a.status === 'COMPLETED' &&
      !!a.completedAt &&
      now.getTime() - a.completedAt.getTime() <= INTAKE_AFTER_COMPLETION_MS;
    if (!open && !justCompleted)
      throw new BadRequestException(
        'Solo se registran equipos de una visita en curso o recién completada.',
      );
    if (dayIn(now) < dayIn(a.startsAt))
      throw new BadRequestException('Podrás registrar equipos a partir del día de la visita.');
    const order = await tx.repairOrder.create({
      data: { appointmentId, ...input, receivedById: user.id },
      include,
    });
    await activity(tx, order, user.id, 'REPAIR_RECEIVED', { device: order.device });
    logEvent('repair.received', { repairOrderId: order.id });
    return serializeRepair(order);
  });
}

/** Equipos de una visita (el técnico a cargo o administración). */
export async function repairsForVisit(user: StaffUser, appointmentId: string) {
  const a = await db.appointment.findUnique({ where: { id: appointmentId } });
  if (!a || a.deletedAt) throw new NotFoundException('Cita no encontrada');
  if (user.role !== 'ADMIN' && a.assignedTechnicianId !== user.id)
    throw new ForbiddenException('Esta cita está asignada a otro técnico.');
  const orders = await db.repairOrder.findMany({
    where: { appointmentId },
    orderBy: { createdAt: 'asc' },
    include,
  });
  return orders.map((o) => serializeRepair(o));
}

// ---------------------------------------------------------------------------------------------
// Administración: lleva el trabajo hasta la entrega.
// ---------------------------------------------------------------------------------------------

export async function adminRepairs(scope: 'shop' | 'done' | 'all' = 'shop', q = '') {
  const text = q.trim();
  const code = /^t?-?0*(\d+)$/i.exec(text)?.[1];
  const where: Prisma.RepairOrderWhereInput = {
    ...(scope === 'shop'
      ? { status: { notIn: ['DELIVERED', 'RETURNED'] } }
      : scope === 'done'
        ? { status: { in: ['DELIVERED', 'RETURNED'] } }
        : {}),
    ...(text
      ? {
          OR: [
            ...(code ? [{ code: Number(code) }] : []),
            { device: { contains: text, mode: 'insensitive' as const } },
            { appointment: { contactName: { contains: text, mode: 'insensitive' as const } } },
            { appointment: { contactPhone: { contains: text.replace(/\D/g, '') || text } } },
          ],
        }
      : {}),
  };
  const [orders, counts] = await Promise.all([
    db.repairOrder.findMany({
      where,
      orderBy: scope === 'done' ? { deliveredAt: 'desc' } : { createdAt: 'asc' },
      take: 200,
      include,
    }),
    db.repairOrder.groupBy({ by: ['status'], _count: true }),
  ]);
  const inShop = counts.filter((c) => repairInShop(c.status)).reduce((sum, c) => sum + c._count, 0);
  const done = counts.reduce((sum, c) => sum + c._count, 0) - inShop;
  return { items: orders.map((o) => serializeRepair(o, true)), counts: { shop: inShop, done } };
}

/** Transiciones que administración hace a mano (presupuesto y entrega tienen las suyas). */
const manualTransitions: Record<string, RepairStatus[]> = {
  RECEIVED: ['DIAGNOSING'],
  DIAGNOSING: [],
  QUOTED: [],
  APPROVED: ['READY'],
  DECLINED: [],
  READY: [],
};

async function loadForUpdate(tx: Prisma.TransactionClient, id: string) {
  const order = await tx.repairOrder.findUnique({ where: { id } });
  if (!order) throw new NotFoundException('Trabajo de taller no encontrado');
  await lockAppointment(tx, order.appointmentId);
  return tx.repairOrder.findUniqueOrThrow({ where: { id } });
}

export async function setRepairStatus(adminId: string, id: string, status: RepairStatus) {
  return db.$transaction(async (tx) => {
    const order = await loadForUpdate(tx, id);
    if (!(manualTransitions[order.status] ?? []).includes(status))
      throw new BadRequestException('Ese cambio de estado no corresponde ahora.');
    const updated = await tx.repairOrder.update({ where: { id }, data: { status }, include });
    await activity(tx, order, adminId, 'REPAIR_STATUS', { from: order.status, to: status });
    return serializeRepair(updated, true);
  });
}

/**
 * Presupuesto: el cliente lo ve en Mi cuenta y, si autorizó WhatsApp, le llega con los botones
 * «Sí, continuar» / «No, devolver». Un presupuesto nuevo reemplaza al anterior sin responder.
 */
export async function quoteRepair(
  adminId: string,
  id: string,
  input: { quoteMinor: number; quoteNote?: string },
  now = new Date(),
) {
  return db.$transaction(async (tx) => {
    const order = await loadForUpdate(tx, id);
    if (!['RECEIVED', 'DIAGNOSING', 'QUOTED'].includes(order.status))
      throw new BadRequestException('Este trabajo ya tiene una respuesta al presupuesto.');
    const updated = await tx.repairOrder.update({
      where: { id },
      data: {
        status: 'QUOTED',
        quoteMinor: input.quoteMinor,
        quoteNote: input.quoteNote?.trim() || null,
        quotedAt: now,
        quoteAnswer: null,
        quoteAnsweredVia: null,
        quoteAnsweredAt: null,
      },
      include,
    });
    // Un presupuesto anterior sin enviar ya no sale.
    await tx.automationJob.updateMany({
      where: { repairOrderId: id, kind: 'REPAIR_QUOTE', status: { in: ['PENDING', 'RETRY'] } },
      data: { status: 'CANCELLED' },
    });
    const a = await tx.appointment.findUniqueOrThrow({ where: { id: order.appointmentId } });
    if (a.whatsappConsentAt && a.contactPhone && !a.bookingIdentityIssue && !a.deletedAt) {
      const dedupeKey = `${a.id}:${a.automationRevision}:REPAIR_QUOTE:${id}:${now.toISOString()}`;
      await tx.automationJob.create({
        data: {
          dedupeKey,
          appointmentId: a.id,
          revision: a.automationRevision,
          kind: 'REPAIR_QUOTE',
          dueAt: now,
          expiresAt: new Date(now.getTime() + QUOTE_ANSWER_MS),
          recipient: a.contactPhone,
          originSessionKey: a.originSessionKey,
          originIpHash: a.originIpHash,
          repairOrderId: id,
        },
      });
    }
    await activity(tx, order, adminId, 'REPAIR_QUOTED', { quoteMinor: input.quoteMinor });
    return serializeRepair(updated, true);
  });
}

/**
 * Respuesta al presupuesto: del cliente (Mi cuenta o botón de WhatsApp) o de administración en
 * su nombre (p. ej. respondió por teléfono). Respondido desde Mi cuenta, el WhatsApp que aún no
 * salió ya no se envía.
 */
async function answerRepair(
  id: string,
  answer: 'APPROVED' | 'DECLINED',
  via: 'WHATSAPP' | 'ACCOUNT' | 'ADMIN',
  actorId: string | null,
  now = new Date(),
) {
  return db.$transaction(async (tx) => {
    const order = await loadForUpdate(tx, id);
    if (order.status !== 'QUOTED' || order.quoteAnswer)
      throw new ConflictException('Este presupuesto ya fue respondido.');
    const updated = await tx.repairOrder.update({
      where: { id },
      data: {
        status: answer,
        quoteAnswer: answer,
        quoteAnsweredVia: via,
        quoteAnsweredAt: now,
      },
      include,
    });
    await tx.automationJob.updateMany({
      where: { repairOrderId: id, kind: 'REPAIR_QUOTE', status: { in: ['PENDING', 'RETRY'] } },
      data: { status: 'CANCELLED' },
    });
    await activity(tx, order, actorId, `REPAIR_QUOTE_${answer}`, { via });
    // Administración se entera (salvo que haya respondido ella misma).
    if (via !== 'ADMIN') {
      const admins = await tx.user.findMany({
        where: { role: 'ADMIN', active: true, deletedAt: null },
        select: { id: true },
      });
      const a = await tx.appointment.findUniqueOrThrow({ where: { id: order.appointmentId } });
      const who = customerFirstName(a.contactName) ?? 'El cliente';
      for (const admin of admins)
        await enqueueStaffMessage(
          tx,
          'REPAIR_ANSWERED',
          a,
          admin.id,
          answer === 'APPROVED'
            ? {
                title: `${who} aprobó el presupuesto`,
                body: `${repairCode(order.code)} · ${order.device}: continuar con la reparación.`,
              }
            : {
                title: `${who} no quiere reparar`,
                body: `${repairCode(order.code)} · ${order.device}: devolver sin reparar.`,
              },
          `repair:${id}:${answer}`,
          now,
        );
    }
    logEvent('repair.quote_answered', { repairOrderId: id, answer, via });
    return updated;
  });
}

export async function adminAnswerRepair(
  adminId: string,
  id: string,
  answer: 'APPROVED' | 'DECLINED',
) {
  const updated = await answerRepair(id, answer, 'ADMIN', adminId);
  return serializeRepair(
    await db.repairOrder.findUniqueOrThrow({ where: { id: updated.id }, include }),
    true,
  );
}

/** Entrega (con lo cobrado) o devolución sin reparar. */
export async function deliverRepair(
  adminId: string,
  id: string,
  input: { returned: boolean; finalMinor: number },
  now = new Date(),
) {
  return db.$transaction(async (tx) => {
    const order = await loadForUpdate(tx, id);
    const allowed = input.returned
      ? ['RECEIVED', 'DIAGNOSING', 'QUOTED', 'DECLINED']
      : ['APPROVED', 'READY'];
    if (!allowed.includes(order.status))
      throw new BadRequestException(
        input.returned
          ? 'Solo se devuelve sin reparar un equipo que no se está reparando.'
          : 'Solo se entrega un equipo reparado (presupuesto aprobado).',
      );
    const updated = await tx.repairOrder.update({
      where: { id },
      data: {
        status: input.returned ? 'RETURNED' : 'DELIVERED',
        finalMinor: input.finalMinor,
        deliveredAt: now,
      },
      include,
    });
    await activity(tx, order, adminId, input.returned ? 'REPAIR_RETURNED' : 'REPAIR_DELIVERED', {
      finalMinor: input.finalMinor,
    });
    return serializeRepair(updated, true);
  });
}

// ---------------------------------------------------------------------------------------------
// Cliente: ve sus equipos (de las citas de su cuenta) y responde el presupuesto.
// ---------------------------------------------------------------------------------------------

export async function customerRepairs(userId: string) {
  const orders = await db.repairOrder.findMany({
    where: { appointment: { userId, deletedAt: null } },
    orderBy: { createdAt: 'desc' },
    take: 100,
    include,
  });
  return orders.map((o) => serializeRepair(o));
}

export async function customerAnswerRepair(
  userId: string,
  id: string,
  answer: 'APPROVED' | 'DECLINED',
) {
  const order = await db.repairOrder.findFirst({
    where: { id, appointment: { userId, deletedAt: null } },
  });
  if (!order) throw new NotFoundException('Trabajo de taller no encontrado');
  await answerRepair(id, answer, 'ACCOUNT', userId);
  return serializeRepair(await db.repairOrder.findUniqueOrThrow({ where: { id }, include }));
}

/** «Sí, continuar» / «No, devolver» (botones del WhatsApp del presupuesto), o null. */
export function repairQuoteAnswer(text: string | null | undefined) {
  const value = (text ?? '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (/continuar/.test(value)) return 'APPROVED' as const;
  if (/devolver/.test(value)) return 'DECLINED' as const;
  return null;
}

/**
 * Botón del WhatsApp del presupuesto. El trabajo se identifica por el mensaje respondido o, si
 * WhatsApp no lo informa, por ser el único presupuesto abierto de ese número.
 */
export async function answerRepairFromWhatsApp(input: {
  phone: string;
  text: string | null;
  inReplyTo: string | null;
}) {
  const answer = repairQuoteAnswer(input.text);
  if (!answer) return null;
  let id: string | null = null;
  if (input.inReplyTo) {
    const job = await db.automationJob.findUnique({
      where: { providerMessageId: input.inReplyTo },
      select: { kind: true, repairOrderId: true },
    });
    if (job?.kind === 'REPAIR_QUOTE') id = job.repairOrderId;
    else if (job) return null;
  }
  if (!id) {
    const open = await db.repairOrder.findMany({
      where: {
        status: 'QUOTED',
        quoteAnswer: null,
        appointment: { contactPhone: input.phone, deletedAt: null },
      },
      select: { id: true },
      take: 2,
    });
    if (open.length !== 1) return null;
    id = open[0].id;
  }
  const order = await db.repairOrder.findUnique({
    where: { id },
    include: { appointment: { select: { contactPhone: true } } },
  });
  if (!order || order.appointment.contactPhone !== input.phone) return null;
  if (order.status !== 'QUOTED' || order.quoteAnswer) return null;
  await answerRepair(id, answer, 'WHATSAPP', null);
  return answer;
}
