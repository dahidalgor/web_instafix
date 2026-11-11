import { emailRequestSchema } from '@instafix/contracts';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { RateLimit } from '../security/rate-limits';
import type { Request } from 'express';
import { maskRecipient } from '../communications/log';
import { db } from '../database/client';
import { pageParams } from '../common/pagination';
import { mailStatus, sendEmail, verifyMailConnection } from '../mail/email.service';
import { testEmail } from '../mail/templates';
import { authenticated, checkOrigin } from './session';

/** Tamaño de página del registro de envíos en Sistema → Correo. */
const LOG_PAGE = 20;

async function logsPage(page: number) {
  const [total, items] = await Promise.all([
    db.communicationLog.count(),
    db.communicationLog.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      skip: (page - 1) * LOG_PAGE,
      take: LOG_PAGE,
      select: {
        channel: true,
        provider: true,
        kind: true,
        recipient: true,
        status: true,
        providerMessageId: true,
        error: true,
        createdAt: true,
      },
    }),
  ]);
  return { total, page, pageSize: LOG_PAGE, items };
}

@Controller('api/v1/admin/email')
export class EmailAdminController {
  @Get('status') async status(@Req() req: Request) {
    await authenticated(req, true);
    const recent = await logsPage(1);
    return { ...mailStatus(), recent: recent.items, recentTotal: recent.total };
  }
  /** Registro de envíos (correo y otros canales), del más reciente, por páginas. */
  @Get('logs') async logs(@Req() req: Request, @Query('page') page = '1') {
    await authenticated(req, true);
    return logsPage(pageParams(page, LOG_PAGE).page);
  }
  @Post('verify')
  @RateLimit('communications')
  async verify(@Req() req: Request) {
    checkOrigin(req);
    await authenticated(req, true);
    return verifyMailConnection();
  }
  /** Envío real controlado a un buzón indicado por el administrador. */
  @Post('test')
  @HttpCode(200)
  @RateLimit('communications')
  async test(@Body() body: unknown, @Req() req: Request) {
    checkOrigin(req);
    const admin = await authenticated(req, true);
    const parsed = emailRequestSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Escribe un correo válido');
    const result = await sendEmail({
      to: parsed.data.email,
      kind: 'TEST',
      userId: admin.id,
      message: testEmail(),
    });
    return {
      accepted: true,
      messageId: result.messageId,
      message: `Brevo aceptó el mensaje para ${maskRecipient(parsed.data.email)}. Comprueba en el buzón si llegó a la bandeja de entrada o a spam: aceptado no equivale a recibido.`,
    };
  }
}
