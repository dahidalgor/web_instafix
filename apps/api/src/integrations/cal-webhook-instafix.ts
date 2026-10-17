import type { Appointment, Prisma } from '@prisma/client';
import { emitAppointmentEvent } from '../appointments/appointment-events';
import { applyRescheduleTx } from '../booking/booking.service';
import { cancelPendingJobs, lockAppointment } from '../whatsapp/queue';
import { appointmentStatusFromCal } from './cal-api';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Lee la referencia que InstaFix envía como metadata al crear la reserva por API. */
export function instafixReference(metadata: unknown): string | null {
  const value = (metadata as Record<string, unknown> | null)?.instafixAppointmentId;
  return typeof value === 'string' && uuid.test(value) ? value : null;
}

// Estados que un webhook ya no puede modificar (la visita terminó o fue sustituida).
const terminal = ['COMPLETED', 'IN_PROGRESS', 'CANCELLED', 'RESCHEDULED', 'NO_SHOW'];

type Context = {
  trigger: string;
  uid: string;
  cancelled: boolean;
  target: Appointment | null;
  previous: Appointment | null;
  payload: Record<string, unknown>;
  start?: Date;
  end?: Date;
  calStatus: string;
  saveEvent: (outcome: string) => Promise<unknown>;
};

/**
 * Sincroniza reservas creadas por InstaFix. A diferencia del formulario anterior, los datos de
 * contacto de Cal.com nunca se leen: el propietario y el teléfono ya están en PostgreSQL.
 */
export async function syncInstafixBooking(tx: Prisma.TransactionClient, ctx: Context) {
  if (ctx.cancelled) {
    const target = ctx.target;
    if (target) {
      await lockAppointment(tx, target.id);
      const current = await tx.appointment.findUniqueOrThrow({ where: { id: target.id } });
      if (!terminal.includes(current.status)) {
        const reason = ctx.payload.cancellationReason;
        const updated = await tx.appointment.update({
          where: { id: current.id },
          data: {
            status: 'CANCELLED',
            calStatus: ctx.trigger === 'BOOKING_REJECTED' ? 'rejected' : 'cancelled',
            cancellationReason: typeof reason === 'string' ? reason.slice(0, 300) : null,
            automationRevision: { increment: 1 },
            calSyncedAt: new Date(),
          },
        });
        await cancelPendingJobs(tx, current.id);
        await emitAppointmentEvent(tx, updated, 'appointment.cancelled');
      }
    }
    await ctx.saveEvent('CANCELLED');
    return { ok: true };
  }

  // Reprogramada desde Cal.com (p. ej. enlace del correo): nueva fila vinculada a la anterior.
  if (!ctx.target && ctx.previous && ctx.start && ctx.end) {
    await applyRescheduleTx(
      tx,
      ctx.previous.id,
      {
        uid: ctx.uid,
        status: ctx.calStatus,
        start: ctx.start.toISOString(),
        end: ctx.end.toISOString(),
      },
      null,
    );
    await ctx.saveEvent('RESCHEDULED');
    return { ok: true };
  }

  const target = ctx.target;
  if (!target || !ctx.start || !ctx.end) {
    await ctx.saveEvent('IGNORED_UNKNOWN');
    return { ignored: true };
  }
  await lockAppointment(tx, target.id);
  const current = await tx.appointment.findUniqueOrThrow({ where: { id: target.id } });
  if (terminal.includes(current.status) || (current.calUid && current.calUid !== ctx.uid)) {
    await ctx.saveEvent('IGNORED_TERMINAL');
    return { ok: true };
  }
  const creating = ['CREATING', 'FAILED'].includes(current.status);
  const status = creating
    ? appointmentStatusFromCal(ctx.calStatus)
    : current.status === 'PENDING_LOCATION' && ctx.calStatus === 'accepted'
      ? 'CONFIRMED'
      : current.status;
  const updated = await tx.appointment.update({
    where: { id: current.id },
    data: {
      calUid: ctx.uid,
      calStatus: ctx.calStatus,
      status,
      startsAt: ctx.start,
      endsAt: ctx.end,
      bookingError: null,
      calSyncedAt: new Date(),
    },
  });
  if (creating) await emitAppointmentEvent(tx, updated, 'appointment.created');
  if (status === 'CONFIRMED' && current.status !== 'CONFIRMED')
    await emitAppointmentEvent(tx, updated, 'appointment.confirmed');
  await ctx.saveEvent('SYNCED');
  return { ok: true };
}

/** BOOKING_NO_SHOW_UPDATED tiene otro formato: {bookingUid, attendees: [{noShow}]}. */
export async function syncNoShow(
  tx: Prisma.TransactionClient,
  payload: Record<string, unknown>,
  saveEvent: (outcome: string) => Promise<unknown>,
) {
  const uid = payload.bookingUid;
  const attendees = Array.isArray(payload.attendees) ? payload.attendees : [];
  const appointment =
    typeof uid === 'string' ? await tx.appointment.findUnique({ where: { calUid: uid } }) : null;
  if (!appointment) {
    await saveEvent('IGNORED_UNKNOWN');
    return { ignored: true };
  }
  await lockAppointment(tx, appointment.id);
  const current = await tx.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
  const noShow = attendees.some((a) => (a as { noShow?: unknown })?.noShow === true);
  if (noShow && ['CONFIRMED', 'PENDING_LOCATION'].includes(current.status)) {
    const updated = await tx.appointment.update({
      where: { id: current.id },
      data: { status: 'NO_SHOW', automationRevision: { increment: 1 } },
    });
    await cancelPendingJobs(tx, current.id);
    await emitAppointmentEvent(tx, updated, 'appointment.no_show');
  } else if (!noShow && current.status === 'NO_SHOW') {
    await tx.appointment.update({ where: { id: current.id }, data: { status: 'CONFIRMED' } });
  }
  await saveEvent(noShow ? 'NO_SHOW' : 'NO_SHOW_CLEARED');
  return { ok: true };
}
