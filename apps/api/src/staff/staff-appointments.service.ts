import { fillLocationArea } from '../whatsapp/location-area';
import { locationFromText } from '../whatsapp/maps-link';
import { recordCompletedJob } from '../jobs/completed-job';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { Appointment, AppointmentService, Prisma } from '@prisma/client';
import type { StaffAppointment } from '@instafix/contracts';
import type { StaffUser } from '../auth/session';
import { db } from '../database/client';
import { confirmCalBooking } from '../integrations/cal-client';
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
    address: a.address,
    locationArea: a.locationArea || null,
    locationLatitude: a.locationLatitude,
    locationLongitude: a.locationLongitude,
    locationReceivedAt: a.locationReceivedAt?.toISOString() ?? null,
    automationIssue: a.automationIssue,
    bookingIdentityIssue: a.bookingIdentityIssue,
    calStatus: a.calStatus,
    assignedTechnician: a.assignedTechnician,
    confirmedAt: a.confirmedAt?.toISOString() ?? null,
    completedAt: a.completedAt?.toISOString() ?? null,
    ...(manage ? { technicianNotes: a.technicianNotes } : {}),
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
    where: { assignedTechnicianId: user.id },
    orderBy: { startsAt: 'asc' },
    include,
  });
  return items.map((a) => serializeStaff(user, a));
}

export async function pendingAppointments(user: StaffUser, now = new Date()) {
  const items = await db.appointment.findMany({
    where: { status: 'PENDING_LOCATION', assignedTechnicianId: null, endsAt: { gt: now } },
    orderBy: { startsAt: 'asc' },
    include,
  });
  return items.map((a) => serializeStaff(user, a));
}

export async function staffAppointment(user: StaffUser, id: string) {
  const a = await db.appointment.findUnique({ where: { id }, include });
  // Un técnico solo ve sus visitas y las pendientes que puede confirmar.
  if (!a || !(canManage(user, a) || isClaimable(a)))
    throw new NotFoundException('Cita no encontrada');
  return serializeStaff(user, a);
}

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

/**
 * Confirmar = asignarse la cita. La identidad sale de la sesión. El bloqueo por cita y la
 * actualización condicional garantizan que, ante dos técnicos simultáneos, solo uno la obtenga
 * y que solo se publique un evento (un correo, un WhatsApp).
 */
export async function confirmAppointment(user: StaffUser, id: string, now = new Date()) {
  const outcome = await db.$transaction(async (tx) => {
    await lockAppointment(tx, id);
    const current = await tx.appointment.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('Cita no encontrada');
    // Repetir la acción (doble pulsación, reintento de red) no genera otra confirmación.
    if (current.status === 'CONFIRMED' && current.assignedTechnicianId === user.id)
      return { already: true, notifications: [] as string[] };
    if (current.status === 'CANCELLED') throw new ConflictException('Esta cita fue cancelada.');
    if (current.assignedTechnicianId || current.status !== 'PENDING_LOCATION')
      throw new ConflictException(takenMessage);
    if (current.endsAt <= now) throw new BadRequestException('Esta cita ya pasó.');
    if (current.bookingIdentityIssue)
      throw new BadRequestException(
        'Los datos de contacto de esta cita están en revisión. Resuélvelo en Administración antes de confirmarla.',
      );
    const claimed = await tx.appointment.updateMany({
      where: { id, status: 'PENDING_LOCATION', assignedTechnicianId: null },
      data: {
        status: 'CONFIRMED',
        assignedTechnicianId: user.id,
        technician: user.name,
        confirmedAt: now,
        confirmedById: user.id,
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
  const cal = outcome.already ? 'NOT_APPLICABLE' : await syncCalConfirmation(id);
  await deliverNow(outcome.notifications);
  return { appointment: await staffAppointment(user, id), alreadyConfirmed: outcome.already, cal };
}

/** Carga la cita bloqueada y comprueba que el usuario puede gestionarla y editar trabajos. */
async function editable(tx: Prisma.TransactionClient, user: StaffUser, id: string) {
  await lockAppointment(tx, id);
  const a = await tx.appointment.findUnique({ where: { id } });
  if (!a) throw new NotFoundException('Cita no encontrada');
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
    if (!a) throw new NotFoundException('Cita no encontrada');
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
        address: coords
          ? location.name || `${location.latitude}, ${location.longitude}`
          : [location.name, location.url].filter(Boolean).join(' · '),
        locationReceivedAt: new Date(),
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

export async function completeAppointment(user: StaffUser, id: string, now = new Date()) {
  const already = await db.$transaction(async (tx) => {
    await lockAppointment(tx, id);
    const a = await tx.appointment.findUnique({ where: { id }, include: { services: true } });
    if (!a) throw new NotFoundException('Cita no encontrada');
    if (!canManage(user, a))
      throw new ForbiddenException('Esta cita está asignada a otro técnico.');
    if (a.status === 'COMPLETED') return true;
    if (!['CONFIRMED', 'IN_PROGRESS'].includes(a.status))
      throw new BadRequestException('Solo se completan citas confirmadas.');
    if (!a.services.length && !a.technicianNotes.trim())
      throw new BadRequestException(
        'Registra al menos un servicio realizado o una nota técnica antes de completar.',
      );
    const done = await tx.appointment.updateMany({
      where: { id, status: { in: ['CONFIRMED', 'IN_PROGRESS'] } },
      data: { status: 'COMPLETED', completedAt: now, completedById: user.id },
    });
    if (!done.count) return true;
    await cancelPendingJobs(tx, id);
    await activity(tx, id, user.id, 'COMPLETED', { services: a.services.length });
    // La cuenta del cliente recibe el trabajo realizado con su garantía.
    await recordCompletedJob(tx, id);
    const updated = await tx.appointment.findUniqueOrThrow({ where: { id } });
    await publishAppointmentEvent(tx, updated, { type: 'appointment.completed' }, now);
    return false;
  });
  return { appointment: await staffAppointment(user, id), alreadyCompleted: already };
}
