import {
  categoryInputSchema,
  categoryUpdateSchema,
  equipmentInputSchema,
  equipmentUpdateSchema,
  offeringSchema,
} from '@instafix/contracts';
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ZodType } from 'zod';
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

  @Get('categories') async categories() {
    return db.serviceCategory.findMany({ orderBy: [{ position: 'asc' }, { name: 'asc' }] });
  }

  @Get('equipment') async equipment() {
    const rows = await db.equipment.findMany({
      orderBy: { name: 'asc' },
      include: { category: { select: { name: true } } },
    });
    return rows.map(({ category, ...item }) => ({ ...item, category: category.name }));
  }

  @Get('admin/services') async services(@Req() req: Request) {
    await authenticated(req, true);
    return db.offering.findMany({
      where: { active: true },
      orderBy: [{ device: 'asc' }, { title: 'asc' }],
    });
  }

  @Post('admin/categories') async addCategory(@Body() body: unknown, @Req() req: Request) {
    checkOrigin(req);
    await authenticated(req, true);
    const data = parse(categoryInputSchema, body);
    const position = data.position ?? (await db.serviceCategory.count());
    return unique(() => db.serviceCategory.create({ data: { name: data.name, position } }));
  }

  @Patch('admin/categories/:id') async editCategory(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    checkOrigin(req);
    await authenticated(req, true);
    const data = parse(categoryUpdateSchema, body);
    await found(db.serviceCategory.findUnique({ where: { id } }), 'Categoría no encontrada');
    return unique(() =>
      db.$transaction(async (tx) => {
        const category = await tx.serviceCategory.update({ where: { id }, data });
        // Los servicios guardan una copia del nombre para el catálogo público.
        if (data.name)
          await tx.offering.updateMany({
            where: { equipment: { categoryId: id } },
            data: { category: category.name },
          });
        return category;
      }),
    );
  }

  @Delete('admin/categories/:id') @HttpCode(204) async removeCategory(
    @Param('id') id: string,
    @Req() req: Request,
  ) {
    checkOrigin(req);
    await authenticated(req, true);
    await found(db.serviceCategory.findUnique({ where: { id } }), 'Categoría no encontrada');
    if (await db.equipment.count({ where: { categoryId: id } }))
      throw new ConflictException('Mueve o elimina primero los equipos de esta categoría');
    await db.serviceCategory.delete({ where: { id } });
  }

  @Post('admin/equipment') async addEquipment(@Body() body: unknown, @Req() req: Request) {
    checkOrigin(req);
    await authenticated(req, true);
    const data = parse(equipmentInputSchema, body);
    await found(
      db.serviceCategory.findUnique({ where: { id: data.categoryId } }),
      'Categoría no encontrada',
    );
    return unique(() => db.equipment.create({ data }));
  }

  @Patch('admin/equipment/:id') async editEquipment(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    checkOrigin(req);
    await authenticated(req, true);
    const data = parse(equipmentUpdateSchema, body);
    await found(db.equipment.findUnique({ where: { id } }), 'Equipo no encontrado');
    if (data.categoryId)
      await found(
        db.serviceCategory.findUnique({ where: { id: data.categoryId } }),
        'Categoría no encontrada',
      );
    return unique(() =>
      db.$transaction(async (tx) => {
        const equipment = await tx.equipment.update({
          where: { id },
          data,
          include: { category: { select: { name: true } } },
        });
        await tx.offering.updateMany({
          where: { equipmentId: id },
          data: { device: equipment.name, category: equipment.category.name },
        });
        const { category, ...item } = equipment;
        return { ...item, category: category.name };
      }),
    );
  }

  @Delete('admin/equipment/:id') @HttpCode(204) async removeEquipment(
    @Param('id') id: string,
    @Req() req: Request,
  ) {
    checkOrigin(req);
    await authenticated(req, true);
    await found(db.equipment.findUnique({ where: { id } }), 'Equipo no encontrado');
    // Los servicios (también los retirados) conservan su equipo para el historial.
    if (await db.offering.count({ where: { equipmentId: id } }))
      throw new ConflictException('Este equipo tiene servicios; muévelos a otro equipo primero');
    await db.equipment.delete({ where: { id } });
  }

  private async serviceData(body: unknown) {
    const parsed = offeringSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const equipment = await db.equipment.findUnique({
      where: { id: parsed.data.equipmentId },
      include: { category: { select: { name: true } } },
    });
    if (!equipment) throw new BadRequestException('Equipo no válido');
    const { cover, ...data } = parsed.data;
    return {
      ...data,
      // undefined = no tocar la portada; null = quitarla (los servicios antiguos usan la 1.ª foto).
      ...(cover === undefined ? {} : { cover: cover ?? Prisma.DbNull }),
      device: equipment.name,
      category: equipment.category.name,
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

function parse<T>(schema: ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new BadRequestException(
      issue?.code === 'unrecognized_keys'
        ? 'Campos no permitidos'
        : issue?.message || 'Datos no válidos',
    );
  }
  return parsed.data;
}
async function found<T>(query: Promise<T | null>, message: string) {
  const row = await query;
  if (!row) throw new NotFoundException(message);
  return row;
}
/** Nombres únicos: un duplicado responde 409 con un mensaje claro. */
async function unique<T>(write: () => Promise<T>) {
  try {
    return await write();
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
      throw new ConflictException('Ya existe uno con ese nombre');
    throw e;
  }
}
