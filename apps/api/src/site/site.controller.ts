import { slideSchema } from '@instafix/contracts/src/site';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { authenticated, checkOrigin } from '../auth/session';
import { db } from '../database/client';

@Controller('api/v1')
export class SiteController {
  @Get('slides') slides() {
    return db.siteSlide.findMany({
      where: { published: true },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
    });
  }

  @Get('admin/slides') async all(@Req() req: Request) {
    await authenticated(req, true);
    return db.siteSlide.findMany({ orderBy: [{ position: 'asc' }, { id: 'asc' }] });
  }

  private parse(body: unknown) {
    const parsed = slideSchema.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException('Revisa el texto, posición y archivo de la diapositiva');
    return parsed.data;
  }

  @Post('admin/slides') async create(@Req() req: Request, @Body() body: unknown) {
    checkOrigin(req);
    await authenticated(req, true);
    return db.siteSlide.create({ data: this.parse(body) });
  }

  @Patch('admin/slides/:id') async update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    checkOrigin(req);
    await authenticated(req, true);
    return db.siteSlide.update({ where: { id }, data: this.parse(body) });
  }

  @Delete('admin/slides/:id') async remove(@Req() req: Request, @Param('id') id: string) {
    checkOrigin(req);
    await authenticated(req, true);
    await db.siteSlide.deleteMany({ where: { id } });
    return { ok: true };
  }
}
