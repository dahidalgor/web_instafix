import {
  loginSchema,
  registrationSchema,
  emailRequestSchema,
  verifyEmailSchema,
  resetPasswordSchema,
} from '@instafix/contracts';
import { normalizePhone } from '@instafix/contracts/src/phone';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { hashPassword, tokenHash, verifyPassword } from '../auth/security';
import {
  authenticated,
  checkOrigin,
  cookieName,
  issueSession,
  safeUser,
  sessionToken,
} from '../auth/session';
import { db } from '../database/client';
import { createChallenge, consumeChallenge } from './email-challenges';
import { assertMailConfigured } from './email';

@Controller('api/v1')
export class AuthController {
  @Post('auth/resend-code') async resend(@Body() body: unknown, @Req() req: Request) {
    checkOrigin(req);
    const parsed = verifyEmailSchema.pick({ challengeId: true }).safeParse(body);
    if (!parsed.success) throw new BadRequestException('Solicitud inválida');
    const c = await db.emailChallenge.findUnique({ where: { id: parsed.data.challengeId } });
    if (!c || c.consumedAt || c.createdAt.getTime() < Date.now() - 86400000)
      throw new BadRequestException('Inicia una nueva solicitud');
    return createChallenge(
      {
        email: c.email,
        purpose: c.purpose as 'REGISTER' | 'RESET',
        name: c.name ?? undefined,
        firstName: c.firstName ?? undefined,
        lastName: c.lastName ?? undefined,
        phone: c.phone ?? undefined,
        passwordHash: c.passwordHash ?? undefined,
        userId: c.userId ?? undefined,
      },
      c.purpose === 'REGISTER' || Boolean(c.userId),
    );
  }
  @Post('auth/register') async register(@Body() body: unknown, @Req() req: Request) {
    checkOrigin(req);
    const data = registrationSchema.safeParse(body);
    if (!data.success || !normalizePhone(data.success ? data.data.phone : '', 'EC'))
      throw new BadRequestException(
        'Revisa nombre, correo, teléfono y contraseña (mínimo 12 caracteres)',
      );
    const existing = await db.user.findFirst({
      where: { OR: [{ phone: data.data.phone }, { email: data.data.email }] },
    });
    if (existing)
      throw new BadRequestException(
        'No se pudo crear la cuenta con estos datos. Prueba iniciar sesión.',
      );
    return createChallenge({
      purpose: 'REGISTER',
      name: `${data.data.firstName} ${data.data.lastName}`,
      firstName: data.data.firstName,
      lastName: data.data.lastName,
      phone: data.data.phone,
      email: data.data.email,
      passwordHash: await hashPassword(data.data.password),
    });
  }

  @Post('auth/verify-email') async verifyEmail(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    checkOrigin(req);
    const parsed = verifyEmailSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Revisa el código');
    let user;
    try {
      user = await consumeChallenge(
        parsed.data.challengeId,
        parsed.data.code,
        'REGISTER',
        async (tx, c) => {
          if (!c.name || !c.phone || !c.passwordHash)
            throw new BadRequestException('Solicitud inválida');
          return tx.user.create({
            data: {
              name: c.name,
              firstName: c.firstName,
              lastName: c.lastName,
              phone: c.phone,
              email: c.email,
              passwordHash: c.passwordHash,
              emailVerifiedAt: new Date(),
            },
            select: safeUser,
          });
        },
      );
    } catch (e: any) {
      if (e.code === 'P2002')
        throw new BadRequestException(
          'Estos datos ya están asociados a una cuenta. Inicia sesión.',
        );
      throw e;
    }
    await issueSession(user.id, res);
    return user;
  }

  @Post('auth/forgot-password') async forgot(@Body() body: unknown, @Req() req: Request) {
    checkOrigin(req);
    const parsed = emailRequestSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Escribe un correo válido');
    assertMailConfigured();
    const user = await db.user.findUnique({ where: { email: parsed.data.email } });
    // La respuesta no revela si el correo pertenece a una cuenta.
    return createChallenge(
      {
        email: parsed.data.email,
        purpose: 'RESET',
        userId: user?.emailVerifiedAt ? user.id : undefined,
      },
      Boolean(user?.emailVerifiedAt),
    );
  }

  @Post('auth/reset-password') async reset(@Body() body: unknown, @Req() req: Request) {
    checkOrigin(req);
    const parsed = resetPasswordSchema.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException(
        'Revisa el código y usa una contraseña de al menos 12 caracteres',
      );
    const passwordHash = await hashPassword(parsed.data.password);
    await consumeChallenge(parsed.data.challengeId, parsed.data.code, 'RESET', async (tx, c) => {
      if (!c.userId) throw new BadRequestException('Solicitud inválida');
      await tx.user.update({ where: { id: c.userId }, data: { passwordHash } });
      await tx.session.deleteMany({ where: { userId: c.userId } });
      await tx.emailChallenge.updateMany({
        where: { userId: c.userId, purpose: 'RESET', consumedAt: null },
        data: { consumedAt: new Date() },
      });
    });
    return { ok: true };
  }

  @Post('auth/login') async login(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    checkOrigin(req);
    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) throw new UnauthorizedException('Teléfono o contraseña incorrectos');
    const user = await db.user.findUnique({ where: { phone: parsed.data.phone } });
    const valid = await verifyPassword(
      parsed.data.password,
      user?.passwordHash ?? '00000000000000000000000000000000:' + '00'.repeat(64),
    );
    if (!user || !valid) throw new UnauthorizedException('Teléfono o contraseña incorrectos');
    await issueSession(user.id, res);
    const { passwordHash, ...result } = user;
    return result;
  }

  @Get('auth/me') async me(@Req() req: Request) {
    return authenticated(req);
  }

  @Post('auth/logout') async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    checkOrigin(req);
    await db.session.deleteMany({ where: { tokenHash: tokenHash(sessionToken(req)) } });
    res.clearCookie(cookieName, { path: '/' });
    return { ok: true };
  }
}
