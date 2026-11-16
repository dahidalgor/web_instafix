import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { rescheduleAnsweredMessage } from '@instafix/contracts';
import type { Appointment, Prisma } from '@prisma/client';
import type { StaffUser } from '../auth/session';
import { logEvent } from '../common/log-event';
import { db } from '../database/client';
import { assertSlotFree, clearProposal, moveConfirmedVisit } from '../booking/booking.service';
import { usesHold } from '../booking/hold';
import { calEventLengthMinutes } from '../integrations/cal-client';
import { deliverNotification } from '../notifications/notification.service';
import { enqueueStaffMessage } from '../notifications/staff/staff-notifications';
import { exclusive, exclusiveWait } from '../security/idempotency';
import { lockAppointment, queueJob } from '../whatsapp/queue';
import { OTHER_VISIT, technicianBusyReason } from './availability';
import { staffAppointment } from './staff-appointments.service';

/**
 * Propuesta de otro horario del técnico al cliente.
 *
 *   técnico propone ──► WhatsApp con botones «Sí, me sirve» / «No, mantener»
 *   cliente acepta  ──► la visita se mueve (Cal.com incluido) y sigue con el mismo técnico
 *   cliente rechaza, no responde a tiempo ──► la visita se queda en su horario
 *
 * En todos los casos el técnico recibe un aviso. Mientras tanto la visita no cambia: el
 * horario propuesto no se reserva (se vuelve a comprobar al aceptar).
 */
export const PROPOSAL_RULES = {
  /** Como mucho, la propuesta espera la respuesta estas horas. */
  answerHours: 12,
  /** Y vence a más tardar estas horas antes de la visita (la actual o la propuesta). */
  beforeVisitHours: 2,
  /** Si no queda al menos este tiempo para responder, no se propone. */
  minimumMinutes: 30,
  /** Horario propuesto: al menos 2 h desde ahora y como mucho 60 días. */
  minLeadHours: 2,
  maxDaysAhead: 60,
} as const;

const HOUR = 3600000;

/** Vencimiento de una propuesta enviada en `now` (null si ya no da tiempo a responder). */
export function proposalDeadline(now: Date, current: Date, proposed: Date) {
  const deadline = new Date(
    Math.min(
      now.getTime() + PROPOSAL_RULES.answerHours * HOUR,
      Math.min(current.getTime(), proposed.getTime()) - PROPOSAL_RULES.beforeVisitHours * HOUR,
    ),
  );
  return deadline.getTime() - now.getTime() >= PROPOSAL_RULES.minimumMinutes * 60000
    ? deadline
    : null;
}

const hasOpenProposal = (a: Appointment, now = new Date()) =>
  a.status === 'CONFIRMED' &&
  !!a.proposedStartsAt &&
  !!a.proposalExpiresAt &&
  a.proposalExpiresAt > now;

async function deliverNow(ids: string[]) {
  for (const id of ids)
    await deliverNotification(id).catch(() => {
      // El worker lo reintenta: un aviso caído no deshace el cambio.
    });
}

/** El técnico asignado propone otro horario: sale el WhatsApp con botones al cliente. */
export async function proposeReschedule(
  user: StaffUser,
  id: string,
  startsAtValue: string,
  now = new Date(),
) {
  const start = new Date(startsAtValue);
  await exclusiveWait(`appointment:${id}`, async () => {
    const a = await db.appointment.findUnique({ where: { id } });
    if (!a || a.deletedAt) throw new NotFoundException('Cita no encontrada');
    if (a.assignedTechnicianId !== user.id)
      throw new ForbiddenException('Solo el técnico a cargo puede proponer otro horario.');
    if (a.status !== 'CONFIRMED' || a.startsAt <= now)
      throw new BadRequestException('Solo se puede proponer otro horario para una visita futura.');
    if (!usesHold(a) || !a.calUid)
      throw new BadRequestException(
        'Esta visita no está en la agenda: pide a administración que cambie la fecha.',
      );
    if (!a.whatsappConsentAt || !a.contactPhone)
      throw new BadRequestException(
        'El cliente no autorizó avisos por WhatsApp: coordina el cambio con administración.',
      );
    if (a.handoverRequestedAt)
      throw new BadRequestException(
        'Tienes un pedido de reemplazo abierto. Retíralo antes de proponer otro horario.',
      );
    if (!Number.isFinite(start.getTime()))
      throw new BadRequestException('Elige la nueva fecha y hora.');
    if (start.getTime() === a.startsAt.getTime())
      throw new BadRequestException('Ese ya es el horario de la visita.');
    if (start.getTime() < now.getTime() + PROPOSAL_RULES.minLeadHours * HOUR)
      throw new BadRequestException(
        `Propón un horario con al menos ${PROPOSAL_RULES.minLeadHours} h de anticipación.`,
      );
    if (start.getTime() > now.getTime() + PROPOSAL_RULES.maxDaysAhead * 24 * HOUR)
      throw new BadRequestException('Propón un horario dentro de los próximos 60 días.');
    const expiresAt = proposalDeadline(now, a.startsAt, start);
    if (!expiresAt)
      throw new BadRequestException(
        'La visita está muy cerca para esperar la respuesta del cliente. Coordina con administración.',
      );
    const end = new Date(start.getTime() + (await calEventLengthMinutes()) * 60000);
    // El horario propuesto debe estar libre en la agenda y para el técnico.
    await assertSlotFree(start, end, a.id, true);
    const busy = await technicianBusyReason(db, user.id, {
      id: a.id,
      startsAt: start,
      endsAt: end,
    });
    if (busy)
      throw new ConflictException(
        busy === OTHER_VISIT
          ? 'Ya tienes otra visita a esa hora.'
          : `Tienes ese horario marcado como ocupado («${busy}»).`,
      );
    await db.$transaction(async (tx) => {
      await lockAppointment(tx, a.id);
      const updated = await tx.appointment.update({
        where: { id: a.id },
        data: {
          proposedStartsAt: start,
          proposedById: user.id,
          proposalSentAt: now,
          proposalExpiresAt: expiresAt,
        },
      });
      await tx.appointmentActivity.create({
        data: {
          appointmentId: a.id,
          actorId: user.id,
          action: 'RESCHEDULE_PROPOSED',
          detail: { from: a.startsAt.toISOString(), to: start.toISOString() },
        },
      });
      // Una propuesta nueva reemplaza a la anterior: su propio envío (clave por momento).
      await queueJob(tx, updated, 'RESCHEDULE_PROPOSAL', now, expiresAt, null, now.toISOString());
    });
    logEvent('booking.reschedule_proposed', { appointmentId: a.id });
  });
  return staffAppointment(user, id);
}

/** El técnico retira su propuesta antes de que el cliente responda. */
export async function withdrawProposal(user: StaffUser, id: string) {
  await exclusiveWait(`appointment:${id}`, async () => {
    const a = await db.appointment.findUnique({ where: { id } });
    if (!a || a.deletedAt) throw new NotFoundException('Cita no encontrada');
    if (a.assignedTechnicianId !== user.id)
      throw new ForbiddenException('Solo el técnico a cargo puede retirar la propuesta.');
    if (!a.proposedStartsAt) return;
    await db.$transaction(async (tx) => {
      await lockAppointment(tx, a.id);
      await tx.appointment.update({ where: { id: a.id }, data: clearProposal });
      // El WhatsApp aún no enviado ya no sale (deja de ser válido sin propuesta).
      await tx.automationJob.updateMany({
        where: {
          appointmentId: a.id,
          kind: 'RESCHEDULE_PROPOSAL',
          status: { in: ['PENDING', 'RETRY'] },
        },
        data: { status: 'CANCELLED' },
      });
      await tx.appointmentActivity.create({
        data: { appointmentId: a.id, actorId: user.id, action: 'RESCHEDULE_PROPOSAL_WITHDRAWN' },
      });
    });
  });
  return staffAppointment(user, id);
}

type Outcome = 'ACCEPTED' | 'DECLINED' | 'EXPIRED' | 'FAILED';

/** Cierra la propuesta y avisa al técnico que la hizo. */
async function closeProposal(
  tx: Prisma.TransactionClient,
  a: Appointment,
  outcome: Outcome,
  now: Date,
) {
  await tx.appointment.update({ where: { id: a.id }, data: clearProposal });
  if (outcome !== 'ACCEPTED')
    await tx.appointmentActivity.create({
      data: {
        appointmentId: a.id,
        actorId: null,
        action: `RESCHEDULE_PROPOSAL_${outcome}`,
        detail: { proposed: a.proposedStartsAt?.toISOString() ?? null },
      },
    });
  if (!a.proposedById || !a.proposedStartsAt) return;
  await enqueueStaffMessage(
    tx,
    'RESCHEDULE_ANSWERED',
    a,
    a.proposedById,
    rescheduleAnsweredMessage(a, outcome, a.proposedStartsAt),
    `${a.proposalSentAt?.toISOString() ?? ''}:${outcome}`,
    now,
  );
}

/** «Sí, me sirve» / «No, mantener» (botones de la plantilla), o null si no es una respuesta. */
export function proposalAnswer(text: string | null | undefined): 'YES' | 'NO' | null {
  const value = (text ?? '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (/^si\b/.test(value)) return 'YES';
  if (/^no\b/.test(value)) return 'NO';
  return null;
}

/**
 * Respuesta del cliente con un botón de la propuesta. La cita se identifica por el mensaje
 * respondido (si WhatsApp lo informa) o, si no, por ser la única propuesta abierta de ese
 * número. Tocar el botón dos veces, o uno viejo, no hace nada: la propuesta ya se cerró.
 */
export async function answerProposal(input: {
  phone: string;
  text: string | null;
  inReplyTo: string | null;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const answer = proposalAnswer(input.text);
  if (!answer) return null;
  let appointmentId: string | null = null;
  if (input.inReplyTo) {
    const job = await db.automationJob.findUnique({
      where: { providerMessageId: input.inReplyTo },
      select: { appointmentId: true, kind: true },
    });
    if (job?.kind === 'RESCHEDULE_PROPOSAL') appointmentId = job.appointmentId;
    else if (job) return null; // Responde a otro aviso: no es esta propuesta.
  }
  if (!appointmentId) {
    const open = await db.appointment.findMany({
      where: {
        contactPhone: input.phone,
        deletedAt: null,
        status: 'CONFIRMED',
        proposedStartsAt: { not: null },
        proposalExpiresAt: { gt: now },
      },
      select: { id: true },
      take: 2,
    });
    if (open.length !== 1) return null;
    appointmentId = open[0].id;
  }
  const id = appointmentId;
  return exclusive(`appointment:${id}`, async (): Promise<Outcome | null> => {
    const a = await db.appointment.findUnique({ where: { id } });
    if (!a || a.deletedAt || a.contactPhone !== input.phone || !hasOpenProposal(a, now))
      return null;
    if (answer === 'NO') {
      const ids = await db.$transaction(async (tx) => {
        await lockAppointment(tx, a.id);
        await closeProposal(tx, a, 'DECLINED', now);
        return tx.notification.findMany({
          where: { appointmentId: a.id, kind: 'RESCHEDULE_ANSWERED', status: 'PENDING' },
          select: { id: true },
        });
      });
      await deliverNow(ids.map((n) => n.id));
      logEvent('booking.reschedule_proposal', { appointmentId: a.id, outcome: 'DECLINED' });
      return 'DECLINED';
    }
    const start = a.proposedStartsAt!;
    const end = new Date(start.getTime() + (await calEventLengthMinutes()) * 60000);
    let outcome: Outcome = 'ACCEPTED';
    try {
      // Se vuelve a comprobar: el horario pudo ocuparse mientras el cliente decidía.
      await assertSlotFree(start, end, a.id, true);
      if (
        await technicianBusyReason(db, a.assignedTechnicianId!, {
          id: a.id,
          startsAt: start,
          endsAt: end,
        })
      )
        throw new ConflictException('El técnico ya no está libre a esa hora.');
      const notifications = await moveConfirmedVisit(a, start, {
        acceptedProposalOf: a.proposedById ?? undefined,
      });
      await deliverNow(notifications);
    } catch (error) {
      if (!(error instanceof HttpException)) throw error;
      outcome = 'FAILED';
      logEvent(
        'booking.reschedule_proposal_failed',
        { appointmentId: a.id, reason: error.message.slice(0, 200) },
        'warn',
      );
    }
    const ids = await db.$transaction(async (tx) => {
      await lockAppointment(tx, a.id);
      await closeProposal(tx, a, outcome, now);
      return tx.notification.findMany({
        where: { appointmentId: a.id, kind: 'RESCHEDULE_ANSWERED', status: 'PENDING' },
        select: { id: true },
      });
    });
    await deliverNow(ids.map((n) => n.id));
    logEvent('booking.reschedule_proposal', { appointmentId: a.id, outcome });
    return outcome;
  });
}

/** Cada minuto: propuestas sin respuesta a tiempo. La visita sigue igual; el técnico lo sabe. */
export async function sweepExpiredProposals(now = new Date()) {
  const expired = await db.appointment.findMany({
    where: { proposedStartsAt: { not: null }, proposalExpiresAt: { lte: now } },
    take: 20,
  });
  for (const a of expired)
    await db.$transaction(async (tx) => {
      await lockAppointment(tx, a.id);
      const current = await tx.appointment.findUniqueOrThrow({ where: { id: a.id } });
      if (
        !current.proposedStartsAt ||
        !current.proposalExpiresAt ||
        current.proposalExpiresAt > now
      )
        return;
      if (current.status === 'CONFIRMED' && !current.deletedAt)
        await closeProposal(tx, current, 'EXPIRED', now);
      else await tx.appointment.update({ where: { id: a.id }, data: clearProposal });
    });
  return expired.length;
}
