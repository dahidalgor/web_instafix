import { BadRequestException, Controller, Get, Param, Post, Req, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { authenticated, checkOrigin } from '../auth/session';
import { processUpload } from './media-processor';
import { directory } from './media-storage';
@Controller('api/v1')
export class MediaController {
  @SkipThrottle()
  @Get('media/:key')
  file(@Param('key') key: string, @Res() res: Response) {
    if (!/^[a-f0-9-]{36}(?:-small|-poster)?\.(webp|mp4)$/.test(key))
      throw new BadRequestException('Archivo no válido');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(key, { root: directory(), maxAge: '1y', immutable: true }, (error) => {
      if (error && !res.headersSent) res.status(404).end();
    });
  }
  @Post('admin/media') async upload(@Req() req: Request) {
    // Validar sesión y origen antes de leer o procesar archivos del dispositivo.
    checkOrigin(req);
    await authenticated(req, true);
    return processUpload(req);
  }
}
