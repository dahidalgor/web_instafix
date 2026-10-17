import { bookingCancelSchema, bookingRescheduleSchema } from '@instafix/contracts';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { authenticated, checkOrigin } from '../auth/session';
import { bookingError } from '../booking/booking-errors';
import {
  availability,
  BOOKING_TIME_ZONE,
  canChange,
  cancelBooking,
  myAppointments,
  ownedAppointment,
  rescheduleBooking,
  toMyAppointment,
} from '../booking/booking.service';
import { availabilityQuerySchema } from '@instafix/contracts';

// El propietario se obtiene siempre de la sesión. Ningún endpoint acepta un userId del navegador,
// y una cita ajena responde 404 igual que una inexistente.
@Controller('api/v1/appointments/me')
export class MyAppointmentsController {
  @Get()
  @Header('Cache-Control', 'no-store')
  async list(@Req() req: Request) {
    const user = await authenticated(req);
    return myAppointments(user.id);
  }

  @Get(':id')
  @Header('Cache-Control', 'no-store')
  async detail(@Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    const user = await authenticated(req);
    return toMyAppointment(await ownedAppointment(user.id, id));
  }

  /** Horarios para reprogramar: Cal.com excluye la propia reserva al calcular conflictos. */
  @Get(':id/availability')
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @Header('Cache-Control', 'no-store')
  async availability(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: Record<string, unknown>,
    @Req() req: Request,
  ) {
    const user = await authenticated(req);
    const appointment = await ownedAppointment(user.id, id);
    if (!canChange(appointment)) throw bookingError('NOT_ALLOWED');
    const parsed = availabilityQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException('Rango de fechas inválido');
    const { start, end } = parsed.data;
    const days = await availability({
      start,
      end,
      rescheduleUid: appointment.calUid!,
      fresh: start === end,
    });
    return { timeZone: BOOKING_TIME_ZONE, days };
  }

  @Post(':id/cancel')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async cancel(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Req() req: Request) {
    checkOrigin(req);
    const user = await authenticated(req);
    const parsed = bookingCancelSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException('Motivo inválido');
    return toMyAppointment(await cancelBooking(user.id, id, parsed.data.reason));
  }

  @Post(':id/reschedule')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async reschedule(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    checkOrigin(req);
    const user = await authenticated(req);
    const parsed = bookingRescheduleSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Elige un nuevo horario');
    return toMyAppointment(await rescheduleBooking(user.id, id, parsed.data));
  }
}
