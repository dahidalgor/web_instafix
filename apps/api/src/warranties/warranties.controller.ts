import { BadRequestException, Body, Controller, Get, Patch, Req } from '@nestjs/common';
import type { Request } from 'express';
import { authenticated, checkOrigin } from '../auth/session';
import { db } from '../database/client';

@Controller('api/v1')
export class WarrantiesController {
  @Get('warranty-policy') async policy() {
    return (
      (await db.sitePolicy.findUnique({ where: { id: 'warranty' } })) ?? {
        text: 'Las condiciones de garantía se informarán para cada servicio antes de contratarlo. Consulta la cobertura y el plazo con Instafix.',
      }
    );
  }

  @Patch('admin/warranty-policy') async editPolicy(@Body() body: any, @Req() req: Request) {
    checkOrigin(req);
    await authenticated(req, true);
    if (typeof body.text !== 'string' || body.text.length < 10 || body.text.length > 10000)
      throw new BadRequestException('Texto de 10 a 10000 caracteres');
    return db.sitePolicy.upsert({
      where: { id: 'warranty' },
      create: { id: 'warranty', text: body.text },
      update: { text: body.text },
    });
  }
}
