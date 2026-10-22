import { normalizePersonName, staffMemberSchema, staffUpdateSchema } from '@instafix/contracts';
import { normalizePhone } from '@instafix/contracts/src/phone';
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { authenticated, checkOrigin } from '../auth/session';
import { hashPassword } from '../auth/security';
import { db } from '../database/client';

const member = {
  id: true,
  name: true,
  firstName: true,
  lastName: true,
  phone: true,
  email: true,
  role: true,
  active: true,
  createdAt: true,
} as const;

/** Equipo técnico. Solo ADMIN; desde aquí solo se crean técnicos, nunca administradores. */
@Controller('api/v1/admin/staff')
export class TeamController {
  @Get() async list(@Req() req: Request) {
    await authenticated(req, true);
    const members = await db.user.findMany({
      where: { role: { in: ['ADMIN', 'TECHNICIAN'] }, deletedAt: null },
      select: member,
      orderBy: [{ role: 'asc' }, { name: 'asc' }],
    });
    const counts = await db.appointment.groupBy({
      by: ['assignedTechnicianId'],
      where: { ...upcomingWhere(), assignedTechnicianId: { in: members.map((m) => m.id) } },
      _count: { _all: true },
    });
    return members.map((m) => ({
      ...m,
      upcomingAppointments: counts.find((c) => c.assignedTechnicianId === m.id)?._count._all ?? 0,
    }));
  }

  @Post() async create(@Body() body: unknown, @Req() req: Request) {
    checkOrigin(req);
    await authenticated(req, true);
    const parsed = staffMemberSchema.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException(parsed.error.issues[0]?.message || 'Revisa los datos');
    const data = parsed.data;
    const phone = normalizePhone(data.phone, 'EC');
    if (!phone) throw new BadRequestException('Teléfono inválido');
    const firstName = normalizePersonName(data.firstName);
    const lastName = normalizePersonName(data.lastName);
    try {
      return await db.user.create({
        data: {
          firstName,
          lastName,
          name: `${firstName} ${lastName}`,
          phone,
          email: data.email || null,
          passwordHash: await hashPassword(data.password),
          role: 'TECHNICIAN',
          // El administrador da de alta el número del técnico: no pasa por el OTP de clientes.
          phoneVerifiedAt: new Date(),
        },
        select: member,
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        throw new ConflictException('Ya existe una cuenta con ese teléfono o correo.');
      throw error;
    }
  }

  @Patch(':id') async update(@Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    checkOrigin(req);
    const admin = await authenticated(req, true);
    const parsed = staffUpdateSchema.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException(parsed.error.issues[0]?.message || 'Revisa los datos');
    const target = await db.user.findUnique({ where: { id } });
    // Solo se gestionan técnicos: ni clientes ni otros administradores ni la propia cuenta.
    if (!target || target.deletedAt || target.role !== 'TECHNICIAN' || target.id === admin.id)
      throw new NotFoundException('Técnico no encontrado');
    const { active, password, confirmFutureAppointments, firstName, lastName, email } = parsed.data;
    const phone =
      parsed.data.phone === undefined ? undefined : normalizePhone(parsed.data.phone, 'EC');
    if (phone === null) throw new BadRequestException('Teléfono inválido');
    const first = firstName ? normalizePersonName(firstName) : target.firstName;
    const last = lastName ? normalizePersonName(lastName) : target.lastName;
    if ((firstName || lastName) && !(first && last))
      throw new BadRequestException('Indica nombre y apellido del técnico');
    const renamed = Boolean(firstName || lastName);
    const name = renamed ? `${first} ${last}` : target.name;
    try {
      return await db.$transaction(async (tx) => {
        // Desactivar no toca citas ni historial; si tiene visitas futuras se pide confirmación
        // explícita para que el administrador sepa que debe gestionarlas.
        if (active === false && target.active) {
          const upcoming = await tx.appointment.count({
            where: { ...upcomingWhere(), assignedTechnicianId: id },
          });
          if (upcoming && !confirmFutureAppointments)
            throw new ConflictException({
              statusCode: 409,
              code: 'TECHNICIAN_HAS_UPCOMING',
              upcoming,
              message: `Tiene ${upcoming === 1 ? '1 cita futura asignada' : `${upcoming} citas futuras asignadas`}. Seguirán a su nombre; gestiónalas desde Citas.`,
            });
        }
        const updated = await tx.user.update({
          where: { id },
          data: {
            ...(renamed ? { firstName: first, lastName: last, name } : {}),
            // El administrador acredita el número del técnico, como al darlo de alta.
            ...(phone && phone !== target.phone ? { phone, phoneVerifiedAt: new Date() } : {}),
            ...(email !== undefined && (email || null) !== target.email
              ? { email: email || null, emailVerifiedAt: null }
              : {}),
            ...(active !== undefined ? { active } : {}),
            ...(password ? { passwordHash: await hashPassword(password) } : {}),
          },
          select: member,
        });
        // El nombre visible de sus visitas futuras sigue al perfil; el historial no se reescribe.
        if (renamed && name !== target.name)
          await tx.appointment.updateMany({
            where: { ...upcomingWhere(), assignedTechnicianId: id },
            data: { technician: name },
          });
        // Desactivar, cambiar la contraseña o el teléfono de acceso cierra sus sesiones.
        if (active === false || password || (phone && phone !== target.phone))
          await tx.session.deleteMany({ where: { userId: id } });
        return updated;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        throw new ConflictException('Ya existe una cuenta con ese teléfono o correo.');
      throw error;
    }
  }
}

/** Visitas aún por atender (no terminadas ni canceladas) que empiezan desde ahora. */
function upcomingWhere(now = new Date()): Prisma.AppointmentWhereInput {
  return {
    deletedAt: null,
    startsAt: { gte: now },
    status: { in: ['PENDING_LOCATION', 'CONFIRMED', 'IN_PROGRESS'] },
  };
}
