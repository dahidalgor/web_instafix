import {
  availabilityQuerySchema,
  bookingCreateSchema,
  type BookingConfig,
  type BookingResult,
} from '@instafix/contracts';
import { maskPhone } from '@instafix/contracts/src/phone';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { authenticated, checkOrigin, sessionToken } from '../auth/session';
import { newToken, tokenHash } from '../auth/security';
import { db } from '../database/client';
import { calBookingConfigured } from '../integrations/cal-api';
import { bookingError } from './booking-errors';
import { availability, BOOKING_TIME_ZONE, createBooking, toMyAppointment } from './booking.service';

/** Sin cookie: invitado. Cookie caducada o inválida: 401, para no reservar con otra identidad. */
async function optionalUser(req: Request) {
  if (!sessionToken(req)) return null;
  return authenticated(req);
}

function nativeBookingEnabled() {
  return calBookingConfigured() && process.env.BOOKING_MODE !== 'legacy';
}

@Controller('api/v1/booking')
export class BookingController {
  /**
   * Indica si la web usa el flujo propio (API de Cal.com configurada) o el formulario
   * anterior. Para una sesión devuelve solo datos enmascarados de la cuenta.
   */
  @Get('config')
  @Header('Cache-Control', 'no-store')
  async config(@Req() req: Request): Promise<BookingConfig> {
    const user = await optionalUser(req);
    return {
      mode: nativeBookingEnabled() ? 'native' : 'legacy',
      timeZone: BOOKING_TIME_ZONE,
      user: user
        ? { name: user.name, maskedPhone: maskPhone(user.phone), email: user.email ?? null }
        : null,
    };
  }

  @Get('availability')
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @Header('Cache-Control', 'no-store')
  async availability(@Query() query: Record<string, unknown>) {
    if (!nativeBookingEnabled()) throw bookingError('NOT_CONFIGURED');
    const parsed = availabilityQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException('Rango de fechas inválido');
    const { start, end } = parsed.data;
    const days = await availability({ start, end, fresh: start === end });
    return { timeZone: BOOKING_TIME_ZONE, days };
  }

  @Post('appointments')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Header('Cache-Control', 'no-store')
  async create(@Body() body: unknown, @Req() req: Request): Promise<BookingResult> {
    checkOrigin(req);
    if (!nativeBookingEnabled()) throw bookingError('NOT_CONFIGURED');
    const parsed = bookingCreateSchema.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException(
        parsed.error.issues[0]?.message || 'Revisa los datos de tu cita',
      );
    const user = await optionalUser(req);
    const appointment = await createBooking(
      parsed.data,
      user ? { id: user.id, name: user.name, phone: user.phone, email: user.email ?? null } : null,
    );
    return { appointment: toMyAppointment(appointment), guest: !user };
  }

  // Formulario anterior de Cal.com (modo legacy): referencia opaca para vincular la reserva.
  @Post('context')
  @Header('Cache-Control', 'no-store')
  async context(@Req() req: Request) {
    checkOrigin(req);
    // La reserva de invitados permanece libre; solo una sesión puede vincular una cuenta.
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
}
