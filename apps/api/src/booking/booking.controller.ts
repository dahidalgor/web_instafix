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
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import { RateLimit } from '../security/rate-limits';
import type { Request, Response } from 'express';
import { requestOrigin } from '../security/client-identity';
import { idempotencyKey, idempotent } from '../security/idempotency';
import { authenticated, checkOrigin, sessionToken } from '../auth/session';
import { newToken, tokenHash } from '../auth/security';
import { db } from '../database/client';
import { getCalSlots } from '../integrations/cal-client';
import { logEvent } from '../common/log-event';
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
  @RateLimit('slots')
  async slots(@Query('from') from: string, @Query('to') to: string) {
    if (!day.test(from || '') || !day.test(to || ''))
      throw new BadRequestException('Indica un rango de fechas válido');
    const start = new Date(`${from}T00:00:00-05:00`);
    const end = new Date(`${to}T23:59:59-05:00`);
    if (end <= start || end.getTime() - start.getTime() > 35 * 86400000)
      throw new BadRequestException('El rango máximo es de 35 días');
    const key = `${from}:${to}`;
    const cached = slotCache.get(key);
    if (cached && cached.at > Date.now() - 30000)
      return { timeZone: 'America/Guayaquil', days: cached.value };
    try {
      const value = await getCalSlots(from, to, 'America/Guayaquil');
      // Un mes entero sin horarios casi siempre es configuración de Cal.com (disponibilidad,
      // rango de fechas, evento): queda en el registro. Administración → WhatsApp lo explica.
      if (!Object.keys(value).length && end.getTime() - start.getTime() >= 20 * 86400000)
        logEvent(
          'booking.slots_empty',
          {
            from,
            to,
            hint: 'Cal.com no ofrece horarios: revisar Administración → WhatsApp → Agenda',
          },
          'warn',
        );
      slotCache.set(key, { at: Date.now(), value });
      if (slotCache.size > 50) slotCache.delete(slotCache.keys().next().value!);
      return { timeZone: 'America/Guayaquil', days: value };
    } catch {
      throw new ServiceUnavailableException(
        'No pudimos consultar los horarios. Inténtalo de nuevo.',
      );
    }
  }

  @Post('booking')
  @HttpCode(201)
  @RateLimit('booking')
  async create(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res?: Response,
  ) {
    checkOrigin(req);
    const parsed = bookingRequestSchema.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException(
        parsed.error.issues[0]?.message || 'Revisa los datos de tu cita',
      );
    // Con sesión, los datos de contacto vienen de la cuenta verificada, nunca del formulario.
    const customer = sessionToken(req) ? await authenticated(req) : null;
    slotCache.clear();
    const origin = requestOrigin(req, res);
    const key = idempotencyKey(req);
    return idempotent(key && `booking:create:${origin.sessionKey}:${key}`, () =>
      createBooking(parsed.data, customer, origin),
    );
  }

  @Post('my/appointments/:id/cancel')
  @HttpCode(200)
  @RateLimit('cancel')
  async cancel(@Param('id') id: string, @Req() req: Request) {
    checkOrigin(req);
    const user = await authenticated(req);
    slotCache.clear();
    const origin = requestOrigin(req);
    const key = idempotencyKey(req);
    return idempotent(key && `booking:cancel:${user.id}:${id}:${key}`, () =>
      cancelBooking(user.id, id, origin),
    );
  }

  @Post('my/appointments/:id/reschedule')
  @HttpCode(200)
  @RateLimit('reschedule')
  async reschedule(@Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    checkOrigin(req);
    const user = await authenticated(req);
    const parsed = rescheduleSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Elige un horario válido');
    slotCache.clear();
    const origin = requestOrigin(req);
    const key = idempotencyKey(req);
    return idempotent(key && `booking:reschedule:${user.id}:${id}:${key}`, () =>
      rescheduleBooking(user.id, id, parsed.data.start, origin),
    );
  }
}
