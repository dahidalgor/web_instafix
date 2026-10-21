import {
  addPerformedServiceSchema,
  technicianNotesSchema,
  updatePerformedServiceSchema,
} from '@instafix/contracts';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { authenticatedStaff, checkOrigin } from '../auth/session';
import {
  addService,
  completeAppointment,
  confirmAppointment,
  myAppointments,
  pendingAppointments,
  removeService,
  saveNotes,
  setLocation,
  staffAppointment,
  syncCalConfirmation,
  updateService,
} from './staff-appointments.service';

const uuid = /^[0-9a-f-]{36}$/i;
function checkId(...ids: string[]) {
  if (!ids.every((id) => uuid.test(id))) throw new BadRequestException('Identificador inválido');
}

/**
 * Panel técnico. Todas las rutas exigen sesión de ADMIN o TECHNICIAN y obtienen la identidad
 * de la sesión: no existe ningún parámetro «technicianId».
 */
@Controller('api/v1/staff')
export class StaffController {
  @Get('me') async me(@Req() req: Request) {
    return authenticatedStaff(req);
  }

  @Get('appointments/me')
  @Header('Cache-Control', 'no-store')
  async mine(@Req() req: Request) {
    return myAppointments(await authenticatedStaff(req));
  }

  @Get('appointments/pending')
  @Header('Cache-Control', 'no-store')
  async pending(@Req() req: Request) {
    return pendingAppointments(await authenticatedStaff(req));
  }

  @Get('appointments/:id')
  @Header('Cache-Control', 'no-store')
  async detail(@Param('id') id: string, @Req() req: Request) {
    checkId(id);
    return staffAppointment(await authenticatedStaff(req), id);
  }

  @Post('appointments/:id/confirm')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  async confirm(@Param('id') id: string, @Req() req: Request) {
    checkOrigin(req);
    checkId(id);
    return confirmAppointment(await authenticatedStaff(req), id);
  }

  @Post('appointments/:id/cal-sync')
  @HttpCode(200)
  async calSync(@Param('id') id: string, @Req() req: Request) {
    checkOrigin(req);
    checkId(id);
    const user = await authenticatedStaff(req);
    await staffAppointment(user, id);
    return { cal: await syncCalConfirmation(id), appointment: await staffAppointment(user, id) };
  }

  @Post('appointments/:id/services')
  async add(@Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    checkOrigin(req);
    checkId(id);
    const parsed = addPerformedServiceSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Elige un servicio y una cantidad válida');
    return addService(await authenticatedStaff(req), id, parsed.data);
  }

  @Patch('appointments/:id/services/:serviceId')
  async update(
    @Param('id') id: string,
    @Param('serviceId') serviceId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    checkOrigin(req);
    checkId(id, serviceId);
    const parsed = updatePerformedServiceSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Cantidad entre 1 y 100');
    return updateService(await authenticatedStaff(req), id, serviceId, parsed.data.quantity);
  }

  @Delete('appointments/:id/services/:serviceId')
  async remove(
    @Param('id') id: string,
    @Param('serviceId') serviceId: string,
    @Req() req: Request,
  ) {
    checkOrigin(req);
    checkId(id, serviceId);
    return removeService(await authenticatedStaff(req), id, serviceId);
  }

  @Put('appointments/:id/notes')
  async notes(@Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    checkOrigin(req);
    checkId(id);
    const parsed = technicianNotesSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Notas de hasta 5000 caracteres');
    return saveNotes(await authenticatedStaff(req), id, parsed.data.notes);
  }

  @Put('appointments/:id/location')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async location(@Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    checkOrigin(req);
    checkId(id);
    const text = (body as { text?: unknown })?.text;
    if (typeof text !== 'string' || !text.trim() || text.length > 2000)
      throw new BadRequestException('Pega un enlace de Google Maps o unas coordenadas');
    return setLocation(await authenticatedStaff(req), id, text);
  }

  @Post('appointments/:id/complete')
  @HttpCode(200)
  async complete(@Param('id') id: string, @Req() req: Request) {
    checkOrigin(req);
    checkId(id);
    return completeAppointment(await authenticatedStaff(req), id);
  }
}
