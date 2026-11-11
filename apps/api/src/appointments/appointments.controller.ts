import {
  appointmentSchema,
  adminAppointmentQuerySchema,
  appointmentSortSchema,
  reassignSchema,
  type AppointmentDateFilter,
  type AppointmentSort,
  type AppointmentStatusFilter,
} from '@instafix/contracts';
import type { Prisma } from '@prisma/client';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { authenticated, checkOrigin } from '../auth/session';
import { db } from '../database/client';
import { normalizePhone } from '@instafix/contracts/src/phone';
import { cancelPendingJobs, lockAppointment, queueJob, queueReminders } from '../whatsapp/queue';
import { z } from 'zod';
import { cancelCalBooking, dayIn } from '../integrations/cal-client';
import { usesHold } from '../booking/hold';
import { busyReason, technicianAgenda } from '../staff/availability';
import { auditAdmin } from '../security/admin-audit';
import { isConsentIssue } from '../whatsapp/consent';
import { deliverNotification } from '../notifications/notification.service';
import { restoreBookingFlow } from './whatsapp-consent';
import { adminRescheduleBooking } from '../booking/booking.service';
import {
  reassignAppointment,
  syncCalConfirmation,
  teamForAppointment,
} from '../staff/staff-appointments.service';
import { exclusive } from '../security/idempotency';

/** createdAt = alta de la cita en Instafix; startsAt = inicio de la visita. Desempate por id. */
export function appointmentOrder(
  sort: AppointmentSort,
): Prisma.AppointmentOrderByWithRelationInput[] {
  const [field, direction] = {
    created_desc: ['createdAt', 'desc'],
    created_asc: ['createdAt', 'asc'],
    starts_asc: ['startsAt', 'asc'],
    starts_desc: ['startsAt', 'desc'],
  }[sort] as ['createdAt' | 'startsAt', 'asc' | 'desc'];
  return [{ [field]: direction }, { id: 'asc' }];
}

/** Estado del organizador → condición (CONFIRMED incluye «en servicio»). */
function statusWhere(filter: AppointmentStatusFilter): Prisma.AppointmentWhereInput {
  if (filter === 'all') return {};
  if (filter === 'active')
    return { status: { in: ['PENDING_LOCATION', 'CONFIRMED', 'IN_PROGRESS'] } };
  if (filter === 'CONFIRMED') return { status: { in: ['CONFIRMED', 'IN_PROGRESS'] } };
  return { status: filter };
}

/** Fecha del organizador (días de Ecuador) → rango de inicio de la cita. */
function dateWhere(
  f: { date: AppointmentDateFilter; from?: string; to?: string },
  now: Date,
): Prisma.AppointmentWhereInput {
  const startOf = (day: string) => new Date(`${day}T00:00:00-05:00`);
  const today = startOf(dayIn(now));
  const days = (n: number) => new Date(today.getTime() + n * 86400000);
  switch (f.date) {
    case 'today':
      return { startsAt: { gte: today, lt: days(1) } };
    case 'upcoming':
      return { startsAt: { gte: today } };
    case 'week':
      return { startsAt: { gte: today, lt: days(8) } };
    case 'past':
      return { startsAt: { lt: today } };
    case 'custom':
      return {
        startsAt: {
          ...(f.from ? { gte: startOf(f.from) } : {}),
          ...(f.to ? { lt: new Date(startOf(f.to).getTime() + 86400000) } : {}),
        },
      };
    default:
      return {};
  }
}

/**
 * Búsqueda por nombre (cita o cuenta), solicitud o teléfono, sin distinguir tildes ni
 * mayúsculas; el teléfono por cualquier parte de sus dígitos (0991…, +593 99…).
 */
async function searchAppointmentIds(text: string) {
  const digits = text.replace(/\D/g, '').replace(/^0/, '');
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT a.id FROM "Appointment" a
    LEFT JOIN "User" u ON u.id = a."userId"
    WHERE a."deletedAt" IS NULL AND (
      translate(lower(coalesce(a."contactName", '') || ' ' || coalesce(u.name, '') || ' ' || a.title),
        'áéíóúüñ', 'aeiouun')
        LIKE '%' || translate(lower(${text}), 'áéíóúüñ', 'aeiouun') || '%'
      OR (${digits.length >= 3} AND (
        regexp_replace(a."contactPhone", '[^0-9]', '', 'g') LIKE '%' || ${digits} || '%'
        OR regexp_replace(coalesce(u.phone, ''), '[^0-9]', '', 'g') LIKE '%' || ${digits} || '%'
      ))
    )
    ORDER BY a."startsAt" DESC
    LIMIT 2000`;
  return rows.map((row) => row.id);
}

@Controller('api/v1')
export class AppointmentsController {
  // La clasificación técnica es independiente de la descripción y del horario reservado.
  @Patch('admin/appointments/:id/service') async assignService(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    checkOrigin(req);
    await authenticated(req, true);
    const parsed = z
      .object({ offeringId: z.string().min(1).max(100) })
      .strict()
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException('Selecciona un servicio del catálogo');
    const offering = await db.offering.findUnique({ where: { id: parsed.data.offeringId } });
    if (!offering) throw new BadRequestException('Servicio no encontrado');
    return db.$transaction(async (tx) => {
      await lockAppointment(tx, id);
      const appointment = await tx.appointment.findUnique({
        where: { id },
        include: { completedJob: true },
      });
      if (
        !appointment ||
        appointment.deletedAt ||
        appointment.completedJob ||
        appointment.status === 'CANCELLED'
      )
        throw new BadRequestException('No se puede asignar un servicio a esta cita');
      return tx.appointment.update({
        where: { id },
        data: { offeringId: offering.id, device: offering.device },
      });
    });
  }

  /**
   * Citas para Administración, por páginas: los filtros (estado, fecha, búsqueda, cliente) y el
   * orden se aplican aquí, así la lista nunca trae todo el historial de golpe. `counts` da el
   * número de citas de cada estado con los demás filtros, para los botones del organizador.
   */
  @Get('admin/appointments') async adminAppointments(
    @Req() req: Request,
    @Query() query: Record<string, string> = {},
  ) {
    await authenticated(req, true);
    const parsed = adminAppointmentQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException('Filtros de citas no válidos');
    const f = parsed.data;
    const now = new Date();
    const base: Prisma.AppointmentWhereInput = {
      deletedAt: null,
      ...(f.id ? { id: f.id } : {}),
      ...(f.userId ? { userId: f.userId } : {}),
      ...dateWhere(f, now),
      ...(f.q ? { id: { in: await searchAppointmentIds(f.q) } } : {}),
    };
    if (f.id && f.q) delete base.id;
    const where = { ...base, ...statusWhere(f.status) };
    const ascending = f.status === 'active' || ['today', 'upcoming', 'week'].includes(f.date);
    const orderBy =
      f.sort === 'auto'
        ? [{ startsAt: ascending ? ('asc' as const) : ('desc' as const) }, { id: 'asc' as const }]
        : appointmentOrder(f.sort as AppointmentSort);
    const [total, rows, byStatus] = await Promise.all([
      db.appointment.count({ where }),
      db.appointment.findMany({
        where,
        orderBy,
        skip: (f.page - 1) * f.pageSize,
        take: f.pageSize,
        include: {
          user: { select: { name: true, phone: true } },
          assignedTechnician: { select: { id: true, name: true, active: true } },
          services: { orderBy: { createdAt: 'asc' } },
        },
      }),
      db.appointment.groupBy({ by: ['status'], where: base, _count: true }),
    ]);
    const n = (...statuses: string[]) =>
      byStatus.filter((g) => statuses.includes(g.status)).reduce((sum, g) => sum + g._count, 0);
    const counts: Record<AppointmentStatusFilter, number> = {
      active: n('PENDING_LOCATION', 'CONFIRMED', 'IN_PROGRESS'),
      PENDING_LOCATION: n('PENDING_LOCATION'),
      CONFIRMED: n('CONFIRMED', 'IN_PROGRESS'),
      COMPLETED: n('COMPLETED'),
      CANCELLED: n('CANCELLED'),
      all: n('PENDING_LOCATION', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'),
    };
    // Pendientes por confirmar: qué técnicos están libres en su horario (null si no aplica).
    const waiting = rows.filter(
      (a) => a.status === 'PENDING_LOCATION' && !a.assignedTechnicianId && a.endsAt > now,
    );
    const agenda = waiting.length
      ? await technicianAgenda(
          db,
          new Date(Math.min(...waiting.map((a) => a.startsAt.getTime()))),
          new Date(Math.max(...waiting.map((a) => a.endsAt.getTime()))),
        )
      : [];
    const waitingIds = new Set(waiting.map((a) => a.id));
    return {
      total,
      page: f.page,
      pageSize: f.pageSize,
      counts,
      items: rows.map((a) => ({
        ...a,
        availableTechnicians: waitingIds.has(a.id)
          ? agenda.filter((tech) => !busyReason(tech, a)).map((tech) => tech.name)
          : null,
      })),
    };
  }

  @Post('admin/appointments') async createAppointment(@Body() body: unknown, @Req() req: Request) {
    checkOrigin(req);
    await authenticated(req, true);
    const parsed = appointmentSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Revisa los datos y las fechas de la cita');
    const { whatsappConsent, ...data } = parsed.data;
    const user = data.userId ? await db.user.findUnique({ where: { id: data.userId } }) : null;
    if (data.userId && (!user || user.role !== 'CUSTOMER' || user.deletedAt))
      throw new BadRequestException('Selecciona un cliente');
    const contactName = data.contactName || user?.name || '';
    const contactPhone = normalizePhone(data.contactPhone || user?.phone || '', 'EC');
    if ((!contactName || !contactPhone) && (whatsappConsent || !data.userId))
      throw new BadRequestException('Revisa nombre y teléfono del invitado');
    return db.$transaction(async (tx) => {
      const appointment = await tx.appointment.create({
        data: {
          ...data,
          contactName,
          contactPhone: contactPhone || user?.phone || '',
          whatsappConsentAt: whatsappConsent ? new Date() : null,
        },
      });
      if (whatsappConsent) {
        if (appointment.status === 'PENDING_LOCATION')
          await queueJob(tx, appointment, 'INITIAL', new Date());
        await queueReminders(tx, appointment);
      }
      return appointment;
    });
  }

  /** Equipo para reasignar una visita: quién está libre en su horario y quién no (y por qué). */
  @Get('admin/appointments/:id/team') async appointmentTeam(
    @Param('id') id: string,
    @Req() req: Request,
  ) {
    await authenticated(req, true);
    return teamForAppointment(id);
  }

  /**
   * Pasar una visita confirmada a otra persona del equipo (p. ej. el técnico la aceptó por error
   * o tuvo un imprevisto). Mismo horario en Cal.com; el cliente recibe un correo.
   */
  @Post('admin/appointments/:id/reassign')
  @HttpCode(200)
  async reassignAppointment(@Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    checkOrigin(req);
    const admin = await authenticated(req, true);
    const parsed = reassignSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Elige a quién pasar la visita.');
    const result = await reassignAppointment(admin, id, parsed.data.technicianId);
    await auditAdmin(admin.id, 'APPOINTMENT_REASSIGNED', id, { to: parsed.data.technicianId });
    return result;
  }

  /**
   * Cambiar fecha y hora de una reserva de Cal.com: se mueve en Cal.com y se avisa al cliente.
   * Las citas manuales (sin Cal.com) cambian su fecha en el formulario normal.
   */
  @Post('admin/appointments/:id/reschedule') async rescheduleAppointment(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    checkOrigin(req);
    const admin = await authenticated(req, true);
    const parsed = z
      .object({
        startsAt: z.string().datetime({ offset: true }),
        keepTechnician: z.boolean().default(true),
      })
      .strict()
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException('Indica la nueva fecha y hora');
    const result = await adminRescheduleBooking(
      admin.id,
      id,
      parsed.data.startsAt,
      parsed.data.keepTechnician,
    );
    // Técnico conservado: Cal.com recibe la confirmación de la reserva nueva (o se reintenta).
    const cal = result.kept ? await syncCalConfirmation(id) : 'NOT_APPLICABLE';
    return { ...result, cal };
  }

  @Patch('admin/appointments/:id') async editAppointment(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    checkOrigin(req);
    const admin = await authenticated(req, true);
    const parsed = appointmentSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Revisa los datos y las fechas de la cita');
    const outcome = await db.$transaction(async (tx) => {
      await lockAppointment(tx, id);
      const existing = await tx.appointment.findUnique({ where: { id } });
      if (!existing || existing.deletedAt || existing.userId !== parsed.data.userId)
        throw new BadRequestException('No se puede cambiar el propietario de una cita');
      const { whatsappConsent, ...data } = parsed.data;
      // Las reservas externas se cancelan/reprograman en Cal para conservar disponibilidad real.
      if (
        usesHold(existing) &&
        (new Date(data.startsAt).getTime() !== existing.startsAt.getTime() ||
          new Date(data.endsAt).getTime() !== existing.endsAt.getTime() ||
          data.status !== existing.status)
      )
        throw new BadRequestException(
          'Para cambiar la fecha de esta reserva usa «Cambiar fecha y hora» en la cita; el estado lo cambian los técnicos o Cal.com.',
        );
      const phone =
        data.contactPhone === undefined
          ? existing.contactPhone
          : normalizePhone(data.contactPhone, 'EC');
      if (data.contactPhone !== undefined && !phone)
        throw new BadRequestException('Teléfono inválido');
      if (
        existing.calUid &&
        (phone !== existing.contactPhone ||
          data.title !== existing.title ||
          (data.contactName !== undefined && data.contactName !== existing.contactName))
      )
        throw new BadRequestException(
          'Edita los datos de contacto y el servicio de esta reserva desde Cal.com.',
        );
      const changed =
        new Date(data.startsAt).getTime() !== existing.startsAt.getTime() ||
        new Date(data.endsAt).getTime() !== existing.endsAt.getTime() ||
        data.timeZone !== existing.timeZone ||
        data.title !== existing.title ||
        phone !== existing.contactPhone ||
        (data.contactName !== undefined && data.contactName !== existing.contactName) ||
        data.status !== existing.status ||
        (whatsappConsent !== undefined && whatsappConsent !== Boolean(existing.whatsappConsentAt));
      if (changed) await cancelPendingJobs(tx, id);
      // Cambio real de fecha/hora = reprogramación (cuenta para el historial; el administrador
      // no está limitado). Notas, técnico o datos internos no la incrementan.
      const moved =
        new Date(data.startsAt).getTime() !== existing.startsAt.getTime() ||
        new Date(data.endsAt).getTime() !== existing.endsAt.getTime();
      // La ubicación recibida pertenece al cliente: solo se descarta si cambia su teléfono.
      const phoneChanged = phone !== existing.contactPhone;
      const appointment = await tx.appointment.update({
        where: { id },
        data: {
          ...data,
          // Con un técnico asignado desde su panel, el nombre visible lo define la asignación.
          technician: existing.assignedTechnicianId ? existing.technician : data.technician,
          contactPhone: phone || '',
          ...(changed
            ? {
                automationRevision: { increment: 1 },
                ...(moved ? { rescheduleCount: { increment: 1 } } : {}),
                ...(phoneChanged
                  ? {
                      locationRequestedAt: new Date(),
                      locationReceivedAt: null,
                      locationLatitude: null,
                      locationLongitude: null,
                      locationArea: null,
                      locationSource: null,
                      locationName: null,
                    }
                  : {}),
              }
            : {}),
          ...(whatsappConsent !== undefined
            ? {
                whatsappConsentAt: whatsappConsent
                  ? existing.whatsappConsentAt || new Date()
                  : null,
                // Autorizada desde el panel: el aviso de «falta autorización» ya no aplica.
                ...(whatsappConsent && isConsentIssue(existing.automationIssue)
                  ? { automationIssue: null }
                  : {}),
              }
            : {}),
        },
      });
      // Reserva de Cal.com sin autorización que el equipo acaba de autorizar: flujo normal
      // (cuenta del cliente, aviso a técnicos y correo de cita recibida).
      const restored =
        whatsappConsent && isConsentIssue(existing.automationIssue)
          ? await restoreBookingFlow(tx, appointment, admin.id)
          : null;
      const saved = restored?.appointment ?? appointment;
      if (changed && saved.whatsappConsentAt) {
        if (saved.status === 'PENDING_LOCATION' && !saved.locationReceivedAt)
          await queueJob(tx, saved, 'INITIAL', new Date());
        await queueReminders(tx, saved);
      }
      return { saved, notifications: restored?.notifications ?? [] };
    });
    for (const notification of outcome.notifications)
      await deliverNotification(notification).catch(() => {
        // La bandeja de avisos reintentará.
      });
    return outcome.saved;
  }

  /**
   * Eliminar ≠ cancelar. Eliminar es administrativo (pruebas, spam, duplicados): la cita deja de
   * mostrarse en todos los paneles, sin avisar al cliente, y conserva su historial (deletedAt).
   * Si seguía activa en Cal.com, se libera el horario. Requiere confirmación explícita.
   */
  @Delete('admin/appointments/:id') async deleteAppointment(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    checkOrigin(req);
    const admin = await authenticated(req, true);
    if (
      !z
        .object({ confirm: z.literal(true) })
        .strict()
        .safeParse(body).success
    )
      throw new BadRequestException('Confirma la eliminación de la cita.');
    return exclusive(`appointment:${id}`, async () => {
      const current = await db.appointment.findUnique({ where: { id } });
      if (!current || current.deletedAt) throw new NotFoundException('Cita no encontrada');
      const active = ['PENDING_LOCATION', 'CONFIRMED', 'IN_PROGRESS'].includes(current.status);
      let calReleased = false;
      if (active && current.calUid && current.startsAt > new Date()) {
        // Sin liberar el horario en Cal.com quedaría ocupado para siempre.
        await cancelCalBooking(current.calUid, 'Eliminada por administración en Instafix');
        calReleased = true;
      }
      await db.$transaction(async (tx) => {
        await lockAppointment(tx, id);
        await tx.appointment.update({
          where: { id },
          data: {
            deletedAt: new Date(),
            deletedById: admin.id,
            automationRevision: { increment: 1 },
            ...(calReleased ? { calStatus: 'cancelled' } : {}),
          },
        });
        // Ningún aviso pendiente sale para una cita eliminada.
        await cancelPendingJobs(tx, id);
        await tx.notification.updateMany({
          where: { appointmentId: id, status: { in: ['PENDING', 'RETRY'] } },
          data: { status: 'CANCELLED' },
        });
        await tx.appointmentActivity.create({
          data: {
            appointmentId: id,
            actorId: admin.id,
            action: 'DELETED',
            detail: { previousStatus: current.status, calReleased },
          },
        });
        await auditAdmin(admin.id, 'APPOINTMENT_DELETED', id, { status: current.status }, tx);
      });
      return { ok: true, calReleased };
    });
  }
}
