import { emailRequestSchema } from '@instafix/contracts';
import { BadRequestException, Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { maskRecipient } from '../communications/log';
import { db } from '../database/client';
import { mailStatus, sendEmail, verifyMailConnection } from '../mail/email.service';
import { testEmail } from '../mail/templates';
import { authenticated, checkOrigin } from './session';

@Controller('api/v1/admin/email')
export class EmailAdminController {
  @Get('status') async status(@Req() req: Request) {
    await authenticated(req, true);
    const recent = await db.communicationLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 30,
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
    });
    return { ...mailStatus(), recent };
  }
  @Post('verify')
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  async verify(@Req() req: Request) {
    checkOrigin(req);
    await authenticated(req, true);
    return verifyMailConnection();
  }
  /** Envío real controlado a un buzón indicado por el administrador. */
  @Post('test')
  @HttpCode(200)
  @Throttle({ default: { limit: 3, ttl: 60000 } })
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
