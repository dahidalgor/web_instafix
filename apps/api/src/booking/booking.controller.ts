import { Controller, Header, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { authenticated, checkOrigin, sessionToken } from '../auth/session';
import { newToken, tokenHash } from '../auth/security';
import { db } from '../database/client';

@Controller('api/v1/booking')
export class BookingController {
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
