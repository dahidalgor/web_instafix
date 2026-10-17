import { BadRequestException, Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { normalizePhone } from '@instafix/contracts/src/phone';
import { authenticated, checkOrigin } from '../auth/session';
import { db } from '../database/client';
import { cancelPendingJobs, lockAppointment } from '../whatsapp/queue';
import { bookingIdentityMessage } from './booking-identity';

@Controller('api/v1/admin/booking-links')
export class BookingAdminController {
  @Get() async candidates(@Req() req: Request) {
    await authenticated(req, true);
    return { recoverable: (await this.recoverable()).length };
  }

  private async recoverable() {
    const intents = await db.bookingIntent.findMany({
      where: { calUid: { not: null }, userId: { not: null } },
      include: { user: true },
    });
    const appointments = await db.appointment.findMany({
      where: {
        userId: null,
        calUid: { in: intents.map((i) => i.calUid!) },
        bookingIdentityIssue: null,
      },
    });
    return appointments.flatMap((appointment) => {
      const intent = intents.find((i) => i.calUid === appointment.calUid);
      // Solo evidencia de una sesión consumida para esa reserva, nunca coincidencia de teléfono sola.
      const user = intent?.user;
      return user &&
        normalizePhone(appointment.contactPhone, 'EC') === normalizePhone(user.phone, 'EC') &&
        normalizePhone(user.phone, 'EC')
        ? [{ appointment, user }]
        : [];
    });
  }

  @Post('recover') async recover(@Req() req: Request) {
    checkOrigin(req);
    const admin = await authenticated(req, true);
    let recovered = 0;
    for (const { appointment, user } of await this.recoverable()) {
      recovered += await db.$transaction(async (tx) => {
        await lockAppointment(tx, appointment.id);
        const updated = await tx.appointment.updateMany({
          where: {
            id: appointment.id,
            userId: null,
            contactPhone: appointment.contactPhone,
            bookingIdentityIssue: null,
          },
          data: { userId: user.id },
        });
        if (updated.count)
          await tx.integrationEvent.create({
            data: {
              id: `account-link:${randomUUID()}`,
              provider: 'ACCOUNT_LINK',
              sourceId: appointment.id,
              occurredAt: new Date(),
              outcome: `RECOVERED:${user.id}:BY:${admin.id}`,
            },
          });
        return updated.count;
      });
    }
    return { recovered };
  }

  @Post(':id') async link(@Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    checkOrigin(req);
    const admin = await authenticated(req, true);
    const parsed = z
      .object({ userId: z.string().uuid(), identityVerified: z.literal(true) })
      .strict()
      .safeParse(body);
    if (!parsed.success)
      throw new BadRequestException('Selecciona una cuenta y verifica la identidad del cliente');
    return db.$transaction(async (tx) => {
      await lockAppointment(tx, id);
      const appointment = await tx.appointment.findUnique({ where: { id } });
      const user = await tx.user.findUnique({ where: { id: parsed.data.userId } });
      if (!appointment || appointment.userId || user?.role !== 'CUSTOMER')
        throw new BadRequestException(
          'La cita no existe, ya tiene propietario o la cuenta no es de cliente',
        );
      const phone = normalizePhone(user.phone, 'EC');
      if (!phone) throw new BadRequestException('La cuenta no tiene un teléfono válido');
      const mismatch = phone !== normalizePhone(appointment.contactPhone, 'EC');
      if (mismatch) await cancelPendingJobs(tx, id);
      const linked = await tx.appointment.update({
        where: { id },
        data: {
          userId: user.id,
          ...(mismatch
            ? {
                bookingIdentityIssue: 'PHONE_MISMATCH',
                automationIssue: bookingIdentityMessage,
                contactPhone: phone,
                contactName: user.name,
              }
            : {}),
        },
        include: { user: { select: { name: true, phone: true } } },
      });
      await tx.integrationEvent.create({
        data: {
          id: `account-link:${randomUUID()}`,
          provider: 'ACCOUNT_LINK',
          sourceId: id,
          occurredAt: new Date(),
          outcome: `VERIFIED:${user.id}:BY:${admin.id}`,
        },
      });
      return linked;
    });
  }
}
