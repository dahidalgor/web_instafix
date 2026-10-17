import { offeringSchema } from '@instafix/contracts';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { randomUUID } from 'node:crypto';
import { authenticated, checkOrigin } from '../auth/session';
import { db } from '../database/client';

@Controller('api/v1')
export class CatalogController {
  @Get('catalog') async catalog() {
    try {
      return await db.offering.findMany({ where: { active: true }, orderBy: { id: 'asc' } });
    } catch {
      throw new ServiceUnavailableException('Base de datos no disponible');
    }
  }

  @Get('equipment') async equipment() {
    return db.equipment.findMany({ orderBy: { name: 'asc' } });
  }

  @Get('admin/services') async services(@Req() req: Request) {
    await authenticated(req, true);
    return db.offering.findMany({
      where: { active: true },
      orderBy: [{ device: 'asc' }, { title: 'asc' }],
    });
  }

  @Post('admin/equipment') async addEquipment(@Body() body: any, @Req() req: Request) {
    checkOrigin(req);
    await authenticated(req, true);
    if (
      typeof body.name !== 'string' ||
      body.name.trim().length < 2 ||
      body.name.length > 100 ||
      typeof body.category !== 'string' ||
      body.category.length < 2 ||
      body.category.length > 100
    )
      throw new BadRequestException('Equipo y categoría requeridos');
    return db.equipment.create({
      data: { name: body.name.trim(), category: body.category.trim() },
    });
  }

  private async serviceData(body: unknown) {
    const parsed = offeringSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const equipment = await db.equipment.findUnique({ where: { id: parsed.data.equipmentId } });
    if (!equipment) throw new BadRequestException('Equipo no válido');
    const { cover, ...data } = parsed.data;
    return {
      ...data,
      // undefined = no tocar la portada; null = quitarla (los servicios antiguos usan la 1.ª foto).
      ...(cover === undefined ? {} : { cover: cover ?? Prisma.DbNull }),
      device: equipment.name,
      category: equipment.category,
    };
  }

  @Post('admin/services') async addService(@Body() body: unknown, @Req() req: Request) {
    checkOrigin(req);
    await authenticated(req, true);
    return db.offering.create({ data: { id: randomUUID(), ...(await this.serviceData(body)) } });
  }

  @Patch('admin/services/:id') async editService(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    checkOrigin(req);
    await authenticated(req, true);
    return db.offering.update({ where: { id }, data: await this.serviceData(body) });
  }
}
