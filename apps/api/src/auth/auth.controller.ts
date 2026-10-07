import { loginSchema, registrationSchema } from '@instafix/contracts';
import { normalizePhone } from '@instafix/contracts/src/phone';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
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

@Controller('api/v1')
export class AuthController {
  @Post('auth/register') async register(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    checkOrigin(req);
    const data = registrationSchema.safeParse(body);
    if (!data.success || !normalizePhone(data.success ? data.data.phone : '', 'EC'))
      throw new BadRequestException('Revisa nombre, teléfono y contraseña (mínimo 12 caracteres)');
    const passwordHash = await hashPassword(data.data.password);
    let user;
    try {
      user = await db.user.create({
        data: { name: data.data.name, phone: data.data.phone, passwordHash },
        select: safeUser,
      });
    } catch (e: any) {
      if (e.code === 'P2002')
        throw new BadRequestException(
          'No se pudo crear la cuenta con estos datos. Prueba iniciar sesión.',
        );
      throw new ServiceUnavailableException('No se pudo crear la cuenta');
    }
    await issueSession(user.id, res);
    return user;
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
