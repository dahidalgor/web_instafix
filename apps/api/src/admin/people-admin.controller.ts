import { normalizePhone } from '@instafix/contracts/src/phone';
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Header,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { hashPassword } from '../auth/security';
import { authenticated, checkOrigin } from '../auth/session';
import { db } from '../database/client';
import { auditAdmin } from '../security/admin-audit';
import { RateLimit } from '../security/rate-limits';

/** Datos de cuenta visibles en Administración: nunca hashes, OTP, tokens ni sesiones. */
const accountFields = {
  id: true,
  name: true,
  phone: true,
  email: true,
  role: true,
  active: true,
  phoneVerifiedAt: true,
  emailVerifiedAt: true,
  createdAt: true,
  _count: { select: { appointments: { where: { deletedAt: null } } } },
} satisfies Prisma.UserSelect;

const roleFilters = ['CUSTOMER', 'TECHNICIAN', 'ADMIN'] as const;
type RoleFilter = (typeof roleFilters)[number];

const blockSchema = z
  .object({
    phone: z.string().trim().min(6).max(30),
    reason: z.string().trim().max(300).optional(),
  })
  .strict();

/** Usuarios y números bloqueados. Solo ADMIN, comprobado en cada ruta. */
@Controller('api/v1/admin')
export class PeopleAdminController {
  @Get('accounts')
  @Header('Cache-Control', 'no-store')
  @RateLimit('staff')
  async accounts(
    @Req() req: Request,
    @Query('q') q = '',
    @Query('role') roleParam = '',
    @Query('page') pageParam = '1',
    @Query('pageSize') sizeParam = '20',
  ) {
    await authenticated(req, true);
    const page = Math.max(1, Math.min(10000, Number.parseInt(pageParam, 10) || 1));
    const pageSize = Math.max(5, Math.min(50, Number.parseInt(sizeParam, 10) || 20));
    const text = q.trim().slice(0, 100);
    const digits = text.replace(/\D/g, '').replace(/^0/, '');
    const role = roleFilters.includes(roleParam as RoleFilter) ? (roleParam as RoleFilter) : null;
    const where: Prisma.UserWhereInput = {
      deletedAt: null,
      ...(role ? { role } : {}),
      ...(text
        ? {
            OR: [
              { name: { contains: text, mode: 'insensitive' } },
              { email: { contains: text.toLowerCase(), mode: 'insensitive' } },
              ...(digits.length >= 3 ? [{ phone: { contains: digits } }] : []),
            ],
          }
        : {}),
    };
    const [total, users] = await Promise.all([
      db.user.count({ where }),
      db.user.findMany({
        where,
        select: accountFields,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    const blocked = new Set(
      (
        await db.blockedPhone.findMany({
          where: { phone: { in: users.map((u) => u.phone) } },
          select: { phone: true },
        })
      ).map((b) => b.phone),
    );
    return {
      page,
      pageSize,
      total,
      items: users.map(({ _count, ...user }) => ({
        ...user,
        appointments: _count.appointments,
        blocked: blocked.has(user.phone),
      })),
    };
  }

  /**
   * Eliminar una cuenta (solo ADMIN, nunca la propia). Sin historial se borra por completo.
   * Con citas, trabajos o actividad del equipo se anonimiza: sin nombre, teléfono, correo ni
   * contraseña utilizables, sesiones y enlaces cerrados; el historial de citas se conserva con
   * sus datos de contacto originales. El teléfono y el correo quedan libres para otra cuenta.
   */
  @Delete('accounts/:id')
  @RateLimit('staff')
  async removeAccount(@Param('id') id: string, @Req() req: Request) {
    checkOrigin(req);
    const admin = await authenticated(req, true);
    if (id === admin.id) throw new BadRequestException('No puedes eliminar tu propia cuenta.');
    const unusablePassword = await hashPassword(randomBytes(32).toString('hex'));
    return db.$transaction(async (tx) => {
      const target = await tx.user.findFirst({
        where: { id, deletedAt: null },
        select: {
          id: true,
          role: true,
          _count: {
            select: {
              appointments: true,
              jobs: true,
              assignedAppointments: true,
              confirmedAppointments: true,
              completedAppointments: true,
              performedServices: true,
              appointmentActivity: true,
            },
          },
        },
      });
      if (!target) throw new NotFoundException('Usuario no encontrado');
      if (target.role !== 'CUSTOMER') {
        const upcoming = await tx.appointment.count({
          where: {
            assignedTechnicianId: id,
            deletedAt: null,
            startsAt: { gte: new Date() },
            status: { in: ['PENDING_LOCATION', 'CONFIRMED', 'IN_PROGRESS'] },
          },
        });
        if (upcoming)
          throw new ConflictException(
            `Tiene ${upcoming === 1 ? '1 cita futura asignada' : `${upcoming} citas futuras asignadas`}. Reasígnalas desde Citas antes de eliminar la cuenta.`,
          );
      }
      // Desafíos pendientes (pueden llevar datos de registro) y enlaces de un solo uso.
      await tx.phoneChallenge.deleteMany({ where: { userId: id } });
      await tx.emailChallenge.deleteMany({ where: { userId: id } });
      const hasHistory = Object.values(target._count).some(Boolean);
      if (hasHistory) {
        await tx.session.deleteMany({ where: { userId: id } });
        await tx.authToken.deleteMany({ where: { userId: id } });
        await tx.bookingIntent.deleteMany({ where: { userId: id } });
        await tx.user.update({
          where: { id },
          data: {
            name: 'Cuenta eliminada',
            firstName: null,
            lastName: null,
            phone: `eliminado:${id}`,
            phoneVerifiedAt: null,
            email: null,
            emailVerifiedAt: null,
            passwordHash: unusablePassword,
            active: false,
            deletedAt: new Date(),
          },
        });
      } else {
        // Sesiones, tokens e intenciones de reserva se borran en cascada.
        await tx.user.delete({ where: { id } });
      }
      await auditAdmin(
        admin.id,
        'USER_DELETED',
        id,
        { role: target.role, mode: hasHistory ? 'anonymized' : 'erased' },
        tx,
      );
      return { ok: true, anonymized: hasHistory };
    });
  }

  @Get('blocked-phones')
  @Header('Cache-Control', 'no-store')
  async blockedPhones(@Req() req: Request) {
    await authenticated(req, true);
    return db.blockedPhone.findMany({ orderBy: { createdAt: 'desc' }, take: 500 });
  }

  @Post('blocked-phones')
  @RateLimit('staff')
  async block(@Body() body: unknown, @Req() req: Request) {
    checkOrigin(req);
    const admin = await authenticated(req, true);
    const parsed = blockSchema.safeParse(body);
    const phone = parsed.success ? normalizePhone(parsed.data.phone, 'EC') : null;
    if (!parsed.success || !phone)
      throw new BadRequestException('Revisa el número (formato E.164).');
    if (phone === admin.phone)
      throw new BadRequestException('No puedes bloquear tu propio número.');
    const reason = parsed.data.reason || null;
    return db.$transaction(async (tx) => {
      const saved = await tx.blockedPhone.upsert({
        where: { phone },
        update: { reason, blockedById: admin.id },
        create: { phone, reason, blockedById: admin.id },
      });
      // Avisos pendientes a ese número: no se envían (el worker también lo comprueba).
      await tx.automationJob.updateMany({
        where: { recipient: phone, status: { in: ['PENDING', 'RETRY'] } },
        data: { status: 'SUPPRESSED_BLOCKED', suppressedReason: 'Número bloqueado' },
      });
      // OTP vigentes de ese número dejan de valer.
      await tx.phoneChallenge.updateMany({
        where: { phone, consumedAt: null },
        data: { consumedAt: new Date(), passwordHash: null },
      });
      await auditAdmin(admin.id, 'PHONE_BLOCKED', phone, { withReason: Boolean(reason) }, tx);
      return saved;
    });
  }

  @Delete('blocked-phones/:phone')
  async unblock(@Param('phone') value: string, @Req() req: Request) {
    checkOrigin(req);
    const admin = await authenticated(req, true);
    const phone = normalizePhone(decodeURIComponent(value), 'EC');
    if (!phone) throw new BadRequestException('Número inválido');
    const removed = await db.blockedPhone.deleteMany({ where: { phone } });
    if (!removed.count) throw new NotFoundException('Este número no está bloqueado.');
    await auditAdmin(admin.id, 'PHONE_UNBLOCKED', phone);
    return { ok: true };
  }
}
