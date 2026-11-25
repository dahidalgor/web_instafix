import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { StaffUser } from '../auth/session';
import { heldAppointments } from '../booking/booking.service';
import { db } from '../database/client';
import { calEventLengthMinutes, getCalSlots } from '../integrations/cal-client';
import { busyReason, technicianAgenda } from './availability';
import { PROPOSAL_RULES, proposalDeadline } from './reschedule-proposal';

const day = /^\d{4}-\d{2}-\d{2}$/;
const HOUR = 3600000;
const TIME_ZONE = 'America/Guayaquil';

/**
 * Horarios a los que se puede mover una visita, con las mismas reglas que valida el servidor al
 * guardar (así no aparece «horario no disponible» después de elegir):
 *  - `proposal`: el técnico a cargo propone otro horario. Libre en Cal.com, sin reserva
 *    provisional de otro cliente, libre para ese técnico (horarios ocupados y otras visitas),
 *    con 2 h de anticipación, dentro de 60 días y con tiempo para que el cliente responda.
 *  - `move`: administración cambia la fecha. Libre en Cal.com (admite hoy) y sin reserva
 *    provisional de otro cliente. Con `technicianId` (mantener al técnico) también libre para él.
 */
export async function appointmentSlots(
  user: StaffUser,
  id: string,
  query: { from?: string; to?: string; purpose?: string; technicianId?: string },
  now = new Date(),
) {
  const { from = '', to = '' } = query;
  if (!day.test(from) || !day.test(to))
    throw new BadRequestException('Indica un rango de fechas válido');
  const rangeStart = new Date(`${from}T00:00:00-05:00`);
  const rangeEnd = new Date(`${to}T23:59:59-05:00`);
  if (rangeEnd <= rangeStart || rangeEnd.getTime() - rangeStart.getTime() > 35 * 86400000)
    throw new BadRequestException('El rango máximo es de 35 días');
  const purpose = query.purpose === 'move' ? 'move' : 'proposal';
  const a = await db.appointment.findUnique({ where: { id } });
  if (!a || a.deletedAt) throw new NotFoundException('Cita no encontrada');
  if (purpose === 'move' && user.role !== 'ADMIN')
    throw new ForbiddenException('Solo administración cambia la fecha de una cita.');
  if (purpose === 'proposal' && a.assignedTechnicianId !== user.id)
    throw new ForbiddenException('Solo el técnico a cargo puede proponer otro horario.');
  // De quién se revisa la disponibilidad: el técnico que propone, o el que se mantiene.
  const technicianId =
    purpose === 'proposal'
      ? user.id
      : query.technicianId && query.technicianId === a.assignedTechnicianId
        ? query.technicianId
        : null;

  // Con la reserva de esta visita descontada: sus propias horas cuentan como libres.
  const offered = await getCalSlots(from, to, TIME_ZONE, { anyDay: true, rescheduleUid: a.calUid });
  const length = (await calEventLengthMinutes()) * 60000;
  const all = Object.values(offered).flat();
  if (!all.length) return { timeZone: TIME_ZONE, days: {} };
  const times = all.map((slot) => new Date(slot).getTime());
  const windowFrom = new Date(Math.min(...times));
  const windowTo = new Date(Math.max(...times) + length);
  const [holds, agenda] = await Promise.all([
    heldAppointments(db, windowFrom, windowTo, a.id),
    technicianId ? technicianAgenda(db, windowFrom, windowTo, technicianId) : Promise.resolve([]),
  ]);
  const tech = agenda[0];
  const minStart =
    now.getTime() + (purpose === 'proposal' ? PROPOSAL_RULES.minLeadHours * HOUR : 5 * 60000);
  const maxStart =
    purpose === 'proposal' ? now.getTime() + PROPOSAL_RULES.maxDaysAhead * 24 * HOUR : Infinity;
  const free = (slot: string) => {
    const start = new Date(slot);
    const end = new Date(start.getTime() + length);
    if (start.getTime() === a.startsAt.getTime()) return false;
    if (start.getTime() < minStart || start.getTime() > maxStart) return false;
    if (purpose === 'proposal' && !proposalDeadline(now, a.startsAt, start)) return false;
    if (holds.some((h) => h.startsAt < end && h.endsAt > start)) return false;
    if (tech && busyReason(tech, { id: a.id, startsAt: start, endsAt: end })) return false;
    return true;
  };
  return {
    timeZone: TIME_ZONE,
    days: Object.fromEntries(
      Object.entries(offered)
        .map(([d, slots]): [string, string[]] => [d, slots.filter(free)])
        .filter(([, slots]) => slots.length),
    ),
  };
}
