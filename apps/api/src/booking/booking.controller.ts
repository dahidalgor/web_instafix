import { bookingRequestSchema, rescheduleSchema } from '@instafix/contracts';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { authenticated, checkOrigin, sessionToken } from '../auth/session';
import { newToken, tokenHash } from '../auth/security';
import { db } from '../database/client';
import { getCalSlots } from '../integrations/cal-client';
import { cancelBooking, createBooking, rescheduleBooking } from './booking.service';

const slotCache = new Map<string, { at: number; value: Record<string, string[]> }>();
const day = /^\d{4}-\d{2}-\d{2}$/;

@Controller('api/v1')
export class BookingController {
  /** Conservado para enlaces antiguos del calendario incrustado. */
  @Post('booking/context')
  @Header('Cache-Control', 'no-store')
  async context(@Req() req: Request) {
    checkOrigin(req);
    if (!sessionToken(req)) return { token: null, user: null };
    const user = await authenticated(req);
    const token = newToken();
    await db.bookingIntent.create({
      data: {
        tokenHash: tokenHash(token),
        userId: user.id,
        expiresAt: new Date(Date.now() + 86400000),
      },
    });
    await db.bookingIntent.deleteMany({ where: { calUid: null, expiresAt: { lt: new Date() } } });
    return { token, user };
  }

  /** Disponibilidad real de Cal.com, sin exponer su API key al navegador. */
  @Get('booking/slots')
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  async slots(@Query('from') from: string, @Query('to') to: string) {
    if (!day.test(from || '') || !day.test(to || ''))
      throw new BadRequestException('Indica un rango de fechas válido');
    const start = new Date(`${from}T00:00:00-05:00`);
    const end = new Date(`${to}T23:59:59-05:00`);
    if (end <= start || end.getTime() - start.getTime() > 35 * 86400000)
      throw new BadRequestException('El rango máximo es de 35 días');
    const key = `${from}:${to}`;
    const cached = slotCache.get(key);
    if (cached && cached.at > Date.now() - 30000) return { timeZone: 'America/Guayaquil', days: cached.value };
    try {
      const value = await getCalSlots(from, to, 'America/Guayaquil');
      slotCache.set(key, { at: Date.now(), value });
      if (slotCache.size > 50) slotCache.delete(slotCache.keys().next().value!);
      return { timeZone: 'America/Guayaquil', days: value };
    } catch {
      throw new ServiceUnavailableException('No pudimos consultar los horarios. Inténtalo de nuevo.');
    }
  }

  @Post('booking')
  @HttpCode(201)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async create(@Body() body: unknown, @Req() req: Request) {
    checkOrigin(req);
    const parsed = bookingRequestSchema.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException(
        parsed.error.issues[0]?.message || 'Revisa los datos de tu cita',
      );
    // Con sesión, los datos de contacto vienen de la cuenta verificada, nunca del formulario.
    const customer = sessionToken(req) ? await authenticated(req) : null;
    slotCache.clear();
    return createBooking(parsed.data, customer);
  }

  @Post('my/appointments/:id/cancel')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async cancel(@Param('id') id: string, @Req() req: Request) {
    checkOrigin(req);
    const user = await authenticated(req);
    slotCache.clear();
    return cancelBooking(user.id, id);
  }

  @Post('my/appointments/:id/reschedule')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async reschedule(@Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    checkOrigin(req);
    const user = await authenticated(req);
    const parsed = rescheduleSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Elige un horario válido');
    slotCache.clear();
    return rescheduleBooking(user.id, id, parsed.data.start);
  }
}
