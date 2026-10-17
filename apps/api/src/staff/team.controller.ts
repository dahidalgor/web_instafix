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
    return db.user.findMany({
      where: { role: { in: ['ADMIN', 'TECHNICIAN'] } },
      select: member,
      orderBy: [{ role: 'asc' }, { name: 'asc' }],
    });
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
    if (!target || target.role !== 'TECHNICIAN' || target.id === admin.id)
      throw new NotFoundException('Técnico no encontrado');
    const { active, password } = parsed.data;
    return db.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id },
        data: {
          ...(active !== undefined ? { active } : {}),
          ...(password ? { passwordHash: await hashPassword(password) } : {}),
        },
        select: member,
      });
      // Desactivar o cambiar la contraseña cierra las sesiones abiertas del técnico.
      if (active === false || password) await tx.session.deleteMany({ where: { userId: id } });
      return updated;
    });
  }
}
