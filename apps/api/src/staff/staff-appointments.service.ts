import { dayIn } from '../integrations/cal-client';
import { fillLocationArea } from '../whatsapp/location-area';
import { locationFromText } from '../whatsapp/maps-link';
import { recordCompletedJob } from '../jobs/completed-job';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Appointment, AppointmentService, Prisma } from '@prisma/client';
import { giveaway, giveawayOpen, type StaffAppointment } from '@instafix/contracts';
import type { StaffUser } from '../auth/session';
import { db } from '../database/client';
import {
  cancelCalBooking,
  confirmCalBooking,
  isCalSlotAvailable,
  type CalHttpError,
} from '../integrations/cal-client';
import { ProviderError } from '../integrations/provider-error';
import { logEvent } from '../common/log-event';
import { exclusiveWait } from '../security/idempotency';
import { createAgendaBooking } from '../booking/booking.service';
import { confirmDeadline } from '../booking/hold';
import { busyReason, OTHER_VISIT, technicianAgenda, technicianBusyReason } from './availability';
import { publishAppointmentEvent } from '../notifications/appointment-events';
import { deliverNotification } from '../notifications/notification.service';
import { cancelPendingJobs, lockAppointment } from '../whatsapp/queue';

/** Marca de incidencia: confirmada en Instafix, pendiente de reflejarse en Cal.com. */
export const CAL_SYNC_ISSUE = 'Confirmada en Instafix; pendiente de confirmar en Cal.com.';
export const takenMessage = 'Esta cita acaba de ser confirmada por otro técnico.';

type Loaded = Appointment & {
  services: AppointmentService[];
  assignedTechnician: { id: string; name: string } | null;
};
const include = {
  services: { orderBy: { createdAt: 'asc' } },
  assignedTechnician: { select: { id: true, name: true } },
} satisfies Prisma.AppointmentInclude;

const isAdmin = (user: StaffUser) => user.role === 'ADMIN';
/** Solo el técnico asignado (o un administrador) gestiona la visita. */
const canManage = (user: StaffUser, appointment: Appointment) =>
  isAdmin(user) || appointment.assignedTechnicianId === user.id;
/** Disponible para que cualquier técnico la confirme. */
const isClaimable = (appointment: Appointment, now = new Date()) =>
  appointment.status === 'PENDING_LOCATION' &&
  !appointment.assignedTechnicianId &&
  appointment.endsAt > now;

export function serializeStaff(user: StaffUser, a: Loaded): StaffAppointment {
  const manage = canManage(user, a);
  return {
    id: a.id,
    status: a.status,
    startsAt: a.startsAt.toISOString(),
    endsAt: a.endsAt.toISOString(),
    timeZone: a.timeZone,
    request: a.title,
    device: a.device,
    contactName: a.contactName,
    // El contacto directo solo lo ve quien atiende la visita.
    contactPhone: manage ? a.contactPhone : '',
    contactEmail: manage ? a.contactEmail : null,
    // La ubicación exacta solo la ve quien atiende la visita. Para decidir si confirmarla basta
    // el sector, que el panel también abre en el mapa (búsqueda del sector, no las coordenadas).
    address: manage ? a.address : '',
    locationArea: a.locationArea || null,
    locationName: manage ? a.locationName : null,
    locationLatitude: manage ? a.locationLatitude : null,
    locationLongitude: manage ? a.locationLongitude : null,
    locationSource: manage ? a.locationSource : null,
    locationReceivedAt: a.locationReceivedAt?.toISOString() ?? null,
    automationIssue: a.automationIssue,
    bookingIdentityIssue: a.bookingIdentityIssue,
    calStatus: a.calStatus,
    assignedTechnician: a.assignedTechnician,
    confirmedAt: a.confirmedAt?.toISOString() ?? null,
    completedAt: a.completedAt?.toISOString() ?? null,
    ...(manage ? { technicianNotes: a.technicianNotes } : {}),
    giveawayEntries: a.giveawayEntries,
    confirmBy: confirmDeadline(a)?.toISOString() ?? null,
    services: a.services.map((s) => ({
      id: s.id,
      offeringId: s.offeringId,
      nameSnapshot: s.nameSnapshot,
      deviceSnapshot: s.deviceSnapshot,
      unitPriceMinor: s.unitPriceMinor,
      quantity: s.quantity,
      totalMinor: s.totalMinor,
      currency: s.currency,
      warrantyDaysSnapshot: s.warrantyDaysSnapshot,
    })),
    canManage: manage,
  };
}

async function activity(
  tx: Prisma.TransactionClient,
  appointmentId: string,
  actorId: string,
  action: string,
  detail: Prisma.InputJsonObject = {},
) {
  await tx.appointmentActivity.create({ data: { appointmentId, actorId, action, detail } });
}

async function deliverNow(ids: string[]) {
  for (const id of ids)
    await deliverNotification(id).catch(() => {
      // La bandeja durable reintentará; nunca se afirma un envío no aceptado.
    });
}

export async function myAppointments(user: StaffUser) {
  const items = await db.appointment.findMany({
    where: { assignedTechnicianId: user.id, deletedAt: null },
    orderBy: { startsAt: 'asc' },
    include,
  });
  return items.map((a) => serializeStaff(user, a));
}

export async function pendingAppointments(user: StaffUser, now = new Date()) {
  const items = await db.appointment.findMany({
    where: {
      status: 'PENDING_LOCATION',
      assignedTechnicianId: null,
      deletedAt: null,
      endsAt: { gt: now },
    },
    orderBy: { startsAt: 'asc' },
    include,
  });
  // Un técnico solo ve las solicitudes de los horarios en que está libre.
  if (user.role !== 'TECHNICIAN' || !items.length) return items.map((a) => serializeStaff(user, a));
  const [me] = await technicianAgenda(
    db,
    items[0].startsAt,
    new Date(Math.max(...items.map((a) => a.endsAt.getTime()))),
    user.id,
  );
  return items.filter((a) => !me || !busyReason(me, a)).map((a) => serializeStaff(user, a));
}

export async function staffAppointment(user: StaffUser, id: string) {
  const a = await db.appointment.findUnique({ where: { id }, include });
  // Un técnico solo ve sus visitas y las pendientes que puede confirmar.
  if (!a || a.deletedAt || !(canManage(user, a) || isClaimable(a)))
    throw new NotFoundException(
      'Esta cita ya no está disponible: otro técnico la confirmó, se canceló o ya pasó.',
    );
  const busy =
    user.role === 'TECHNICIAN' && isClaimable(a)
      ? await technicianBusyReason(db, user.id, a)
      : null;
  return { ...serializeStaff(user, a), busyReason: busy };
}

/** Mensaje para un técnico que intenta confirmar en un horario en que no está libre. */
const busyMessage = (reason: string) =>
  reason === OTHER_VISIT
    ? 'Ya tienes otra visita confirmada a esa hora.'
    : `Tienes ese horario marcado como ocupado («${reason}»). Si sí puedes ir, quítalo en Horarios y vuelve a confirmar.`;

/**
 * Refleja la confirmación en Cal.com (reserva «pendiente» → «aceptada»). Si Cal.com falla, la
 * cita sigue confirmada en Instafix y queda marcada para reintentarlo; nunca se cancela ni se
 * vuelve a crear la reserva.
 */
export async function syncCalConfirmation(id: string) {
  const a = await db.appointment.findUnique({ where: { id } });
  if (!a?.calUid || a.status !== 'CONFIRMED') return 'NOT_APPLICABLE' as const;
  try {
    await confirmCalBooking(a.calUid);
    await db.appointment.updateMany({
      where: { id, status: 'CONFIRMED' },
      data: {
        calStatus: 'accepted',
        ...(a.automationIssue === CAL_SYNC_ISSUE ? { automationIssue: null } : {}),
      },
    });
    return 'SYNCED' as const;
  } catch {
    await db.appointment.updateMany({
      where: {
        id,
        status: 'CONFIRMED',
        OR: [{ automationIssue: null }, { automationIssue: CAL_SYNC_ISSUE }],
      },
      data: { automationIssue: CAL_SYNC_ISSUE },
    });
    return 'PENDING' as const;
  }
}

/** Reintento periódico de las confirmaciones que Cal.com no aceptó a la primera. */
export async function retryCalConfirmations(now = new Date()) {
  if (!process.env.CAL_API_KEY) return;
  const pending = await db.appointment.findMany({
    where: {
      status: 'CONFIRMED',
      automationIssue: CAL_SYNC_ISSUE,
      startsAt: { gt: now },
      updatedAt: { lt: new Date(now.getTime() - 120000) },
    },
    select: { id: true },
    take: 5,
  });
  for (const { id } of pending) {
    // Toca updatedAt para espaciar los reintentos aunque Cal.com siga fallando.
    await db.appointment.update({ where: { id }, data: { automationIssue: CAL_SYNC_ISSUE } });
    await syncCalConfirmation(id);
  }
}

/** El horario ya no está libre en Cal.com (reserva directa, bloqueo del calendario…). */
export const CAL_SLOT_ISSUE =
  'Ese horario ya no está libre en Cal.com: cambia la fecha y hora de la cita para poder confirmarla.';

/** Comprobaciones previas a confirmar (se repiten dentro de la transacción). */
function assertClaimable(current: Appointment | null, user: StaffUser, now: Date) {
  if (!current || current.deletedAt) throw new NotFoundException('Cita no encontrada');
  if (current.status === 'CONFIRMED' && current.assignedTechnicianId === user.id) return 'MINE';
  if (current.status === 'CANCELLED')
    throw new ConflictException(
      current.autoCancelReason
        ? 'Esta cita se canceló automáticamente porque venció su plazo.'
        : 'Esta cita fue cancelada.',
    );
  if (current.assignedTechnicianId || current.status !== 'PENDING_LOCATION')
    throw new ConflictException(takenMessage);
  if (current.endsAt <= now) throw new BadRequestException('Esta cita ya pasó.');
  if (current.bookingIdentityIssue)
    throw new BadRequestException(
      'Los datos de contacto de esta cita están en revisión. Resuélvelo en Administración antes de confirmarla.',
    );
  return 'CLAIMABLE';
}

/**
 * Reserva provisional → reserva real en Cal.com, al confirmar. Si Cal.com ya no tiene ese
 * horario, la confirmación no ocurre y la cita queda marcada para que administración la mueva.
 */
async function reserveInCal(a: Appointment) {
  try {
    return await createAgendaBooking({
      start: a.startsAt,
      name: a.contactName || 'Cliente Instafix',
      phone: a.contactPhone,
      request: a.title,
      whatsappConsent: Boolean(a.whatsappConsentAt),
      appointmentId: a.id,
    });
  } catch (error) {
    const status = error instanceof ProviderError ? (error as CalHttpError).httpStatus : undefined;
    const check =
      error instanceof ProviderError && error.disposition === 'FAILED' && status
        ? await isCalSlotAvailable(a.startsAt).catch(() => null)
        : null;
    logEvent(
      'staff.confirm_cal_rejected',
      {
        appointmentId: a.id,
        calStatus: status ?? null,
        available: check?.available ?? null,
        reason:
          error instanceof ProviderError
            ? (error as CalHttpError).providerMessage || error.message
            : 'Error inesperado',
      },
      'warn',
    );
    if (check && !check.available) {
      await db.appointment.updateMany({
        where: { id: a.id, status: 'PENDING_LOCATION' },
        data: { automationIssue: CAL_SLOT_ISSUE },
      });
      throw new ConflictException(
        'Ese horario ya no está libre en Cal.com. Pide a administración que cambie la fecha y hora de la cita.',
      );
    }
    if (error instanceof ProviderError && error.disposition === 'REVIEW')
      throw new ServiceUnavailableException(
        'Cal.com no respondió a tiempo. Espera un minuto y revisa si la cita ya aparece confirmada antes de intentarlo otra vez.',
      );
    throw new ServiceUnavailableException(
      'Cal.com no aceptó la reserva en este momento. Inténtalo de nuevo en unos minutos.',
    );
  }
}

/**
 * Confirmar = asignarse la cita. La identidad sale de la sesión. Una sola operación por cita a
 * la vez y la actualización condicional garantizan que, ante dos técnicos simultáneos, solo uno
 * la obtenga y que solo se publique un evento (un correo, un WhatsApp). Si la cita era una
 * reserva provisional, la reserva de Cal.com se crea recién aquí.
 */
export async function confirmAppointment(user: StaffUser, id: string, now = new Date()) {
  const outcome = await exclusiveWait(`appointment:${id}`, async () => {
    const before = await db.appointment.findUnique({ where: { id } });
    if (assertClaimable(before, user, now) === 'MINE')
      return { already: true, notifications: [] as string[] };
    // Un técnico no puede tomar una cita en un horario en que no está libre (administración sí).
    if (user.role === 'TECHNICIAN') {
      const reason = await technicianBusyReason(db, user.id, before!);
      if (reason) throw new ConflictException(busyMessage(reason));
    }
    // Solo una reserva provisional de la web pasa a Cal.com; las manuales no están en la agenda.
    const created =
      !before!.calUid && before!.source === 'INSTAFIX_API' ? await reserveInCal(before!) : null;
    // Cal.com debe reservar exactamente ese horario; si no, se anula y no se confirma.
    if (created && created.start.getTime() !== before!.startsAt.getTime()) {
      await cancelCalBooking(created.uid, 'Horario distinto al solicitado').catch(() =>
        logEvent('staff.confirm_cal_release_failed', { appointmentId: id }, 'warn'),
      );
      logEvent('staff.confirm_cal_mismatch', { appointmentId: id }, 'warn');
      throw new ServiceUnavailableException(
        'Cal.com reservó otro horario. Pide a administración que revise la cita.',
      );
    }
    try {
      return await db.$transaction(async (tx) => {
        await lockAppointment(tx, id);
        const current = await tx.appointment.findUnique({ where: { id } });
        // Repetir la acción (doble pulsación, reintento de red) no genera otra confirmación.
        if (assertClaimable(current, user, now) === 'MINE')
          return { already: true, notifications: [] as string[] };
        const claimed = await tx.appointment.updateMany({
          where: { id, status: 'PENDING_LOCATION', assignedTechnicianId: null },
          data: {
            status: 'CONFIRMED',
            assignedTechnicianId: user.id,
            technician: user.name,
            confirmedAt: now,
            confirmedById: user.id,
            ...(created
              ? { calUid: created.uid, calStatus: created.status, endsAt: created.end }
              : {}),
            ...(current!.automationIssue === CAL_SLOT_ISSUE ? { automationIssue: null } : {}),
          },
        });
        if (!claimed.count) throw new ConflictException(takenMessage);
        const updated = await tx.appointment.findUniqueOrThrow({ where: { id } });
        await activity(tx, id, user.id, 'CONFIRMED', { technicianId: user.id });
        const notifications = await publishAppointmentEvent(
          tx,
          updated,
          { type: 'appointment.confirmed', technicianName: user.name },
          now,
        );
        return { already: false, notifications };
      });
    } catch (error) {
      // No quedó confirmada: la reserva recién creada en Cal.com se libera.
      if (created)
        await cancelCalBooking(created.uid, 'Confirmación no completada en Instafix').catch(() =>
          logEvent('staff.confirm_cal_release_failed', { appointmentId: id }, 'warn'),
        );
      throw error;
    }
  });
  const cal = outcome.already ? 'NOT_APPLICABLE' : await syncCalConfirmation(id);
  await deliverNow(outcome.notifications);
  return { appointment: await staffAppointment(user, id), alreadyConfirmed: outcome.already, cal };
}

/** Carga la cita bloqueada y comprueba que el usuario puede gestionarla y editar trabajos. */
async function editable(tx: Prisma.TransactionClient, user: StaffUser, id: string) {
  await lockAppointment(tx, id);
  const a = await tx.appointment.findUnique({ where: { id } });
  if (!a || a.deletedAt) throw new NotFoundException('Cita no encontrada');
  if (!canManage(user, a)) throw new ForbiddenException('Esta cita está asignada a otro técnico.');
  if (!['CONFIRMED', 'IN_PROGRESS'].includes(a.status))
    throw new BadRequestException(
      a.status === 'COMPLETED'
        ? 'La cita ya está completada.'
        : 'Confirma la cita antes de registrar trabajos.',
    );
  return a;
}

export async function addService(
  user: StaffUser,
  id: string,
  input: { offeringId: string; quantity: number },
) {
  await db.$transaction(async (tx) => {
    await editable(tx, user, id);
    const offering = await tx.offering.findFirst({ where: { id: input.offeringId, active: true } });
    if (!offering) throw new BadRequestException('Servicio no encontrado en el catálogo');
    const duplicate = await tx.appointmentService.findUnique({
      where: { appointmentId_offeringId: { appointmentId: id, offeringId: offering.id } },
    });
    if (duplicate)
      throw new ConflictException('Este servicio ya está registrado. Ajusta su cantidad.');
    // Instantánea del catálogo: el precio aplicado no cambia si el catálogo cambia después.
    const created = await tx.appointmentService.create({
      data: {
        appointmentId: id,
        offeringId: offering.id,
        nameSnapshot: offering.title,
        deviceSnapshot: offering.device,
        unitPriceMinor: offering.priceMinor,
        quantity: input.quantity,
        totalMinor: offering.priceMinor * input.quantity,
        currency: offering.currency,
        warrantyDaysSnapshot: offering.warrantyDays,
        addedById: user.id,
      },
    });
    await activity(tx, id, user.id, 'SERVICE_ADDED', {
      serviceId: created.id,
      offeringId: offering.id,
      quantity: input.quantity,
    });
  });
  return staffAppointment(user, id);
}

export async function updateService(
  user: StaffUser,
  id: string,
  serviceId: string,
  quantity: number,
) {
  await db.$transaction(async (tx) => {
    await editable(tx, user, id);
    const item = await tx.appointmentService.findFirst({
      where: { id: serviceId, appointmentId: id },
    });
    if (!item) throw new NotFoundException('Servicio no encontrado');
    await tx.appointmentService.update({
      where: { id: serviceId },
      data: { quantity, totalMinor: item.unitPriceMinor * quantity },
    });
    await activity(tx, id, user.id, 'SERVICE_QUANTITY', {
      serviceId,
      from: item.quantity,
      to: quantity,
    });
  });
  return staffAppointment(user, id);
}

export async function removeService(user: StaffUser, id: string, serviceId: string) {
  await db.$transaction(async (tx) => {
    await editable(tx, user, id);
    const removed = await tx.appointmentService.deleteMany({
      where: { id: serviceId, appointmentId: id },
    });
    if (!removed.count) throw new NotFoundException('Servicio no encontrado');
    await activity(tx, id, user.id, 'SERVICE_REMOVED', { serviceId });
  });
  return staffAppointment(user, id);
}

export async function saveNotes(user: StaffUser, id: string, notes: string) {
  await db.$transaction(async (tx) => {
    const a = await editable(tx, user, id);
    if (a.technicianNotes === notes) return;
    await tx.appointment.update({ where: { id }, data: { technicianNotes: notes } });
    await activity(tx, id, user.id, 'NOTES_UPDATED', { length: notes.length });
  });
  return staffAppointment(user, id);
}

/**
 * Ubicación pegada por el técnico (enlace de Google/Apple Maps o coordenadas), p. ej. cuando el
 * cliente la mandó por otro medio. Solo quien gestiona la visita.
 */
export async function setLocation(user: StaffUser, id: string, text: string) {
  // Fuera de la transacción: un enlace corto puede requerir consultar a Google.
  const location = await locationFromText(text);
  if (!location)
    throw new BadRequestException(
      'No reconocimos la ubicación. Pega un enlace de Google Maps o coordenadas como -0.1807, -78.4678.',
    );
  await db.$transaction(async (tx) => {
    await lockAppointment(tx, id);
    const a = await tx.appointment.findUnique({ where: { id } });
    if (!a || a.deletedAt) throw new NotFoundException('Cita no encontrada');
    if (!canManage(user, a))
      throw new ForbiddenException('Esta cita está asignada a otro técnico.');
    if (!['PENDING_LOCATION', 'CONFIRMED', 'IN_PROGRESS'].includes(a.status))
      throw new BadRequestException('Esta cita ya no admite cambios de ubicación.');
    const coords = location.latitude !== undefined && location.longitude !== undefined;
    await tx.appointment.update({
      where: { id },
      data: {
        locationLatitude: coords ? location.latitude : null,
        locationLongitude: coords ? location.longitude : null,
        locationName: coords ? location.name || null : null,
        ...(coords ? {} : { address: [location.name, location.url].filter(Boolean).join(' · ') }),
        locationReceivedAt: new Date(),
        locationSource: 'STAFF',
        locationArea: null,
      },
    });
    // Ya no hace falta pedirla por WhatsApp.
    await tx.automationJob.updateMany({
      where: { appointmentId: id, kind: 'INITIAL', status: { in: ['PENDING', 'RETRY'] } },
      data: { status: 'CANCELLED' },
    });
    await activity(tx, id, user.id, 'LOCATION_SET', { coordinates: coords });
  });
  await fillLocationArea(id);
  return staffAppointment(user, id);
}

export async function completeAppointment(
  user: StaffUser,
  id: string,
  now = new Date(),
  { giveawayEntries = 0 }: { giveawayEntries?: number } = {},
) {
  if (giveawayEntries > 0 && !giveawayOpen(now))
    throw new BadRequestException(`El sorteo de ${giveaway.prize} ya cerró.`);
  const already = await db.$transaction(async (tx) => {
    await lockAppointment(tx, id);
    const a = await tx.appointment.findUnique({ where: { id }, include: { services: true } });
    if (!a || a.deletedAt) throw new NotFoundException('Cita no encontrada');
    if (!canManage(user, a))
      throw new ForbiddenException('Esta cita está asignada a otro técnico.');
    if (a.status === 'COMPLETED') return true;
    if (!['CONFIRMED', 'IN_PROGRESS'].includes(a.status))
      throw new BadRequestException('Solo se completan citas confirmadas.');
    // No se completa antes del día de la visita (fecha de Ecuador).
    if (dayIn(now) < dayIn(a.startsAt))
      throw new BadRequestException('Solo puedes completar la visita a partir del día de la cita.');
    if (!a.services.length && !a.technicianNotes.trim())
      throw new BadRequestException(
        'Registra al menos un servicio realizado o una nota técnica antes de completar.',
      );
    const done = await tx.appointment.updateMany({
      where: { id, status: { in: ['CONFIRMED', 'IN_PROGRESS'] } },
      data: { status: 'COMPLETED', completedAt: now, completedById: user.id, giveawayEntries },
    });
    if (!done.count) return true;
    await cancelPendingJobs(tx, id);
    await activity(tx, id, user.id, 'COMPLETED', {
      services: a.services.length,
      ...(giveawayEntries ? { giveawayEntries } : {}),
    });
    // La cuenta del cliente recibe el trabajo realizado con su garantía.
    await recordCompletedJob(tx, id);
    const updated = await tx.appointment.findUniqueOrThrow({ where: { id } });
    await publishAppointmentEvent(tx, updated, { type: 'appointment.completed' }, now);
    return false;
  });
  return { appointment: await staffAppointment(user, id), alreadyCompleted: already };
}
