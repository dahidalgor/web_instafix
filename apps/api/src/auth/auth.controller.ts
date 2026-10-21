import {
  completeResetSchema,
  emailRequestSchema,
  loginSchema,
  registrationSchema,
  resendVerificationSchema,
  tokenSchema,
  verifyPhoneSchema,
} from '@instafix/contracts';
import { maskPhone, normalizePhone } from '@instafix/contracts/src/phone';
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpException,
  Post,
  Req,
  Res,
  UnauthorizedException,
  Inject,
} from '@nestjs/common';
import { logEvent } from '../common/log-event';
import { RateLimit } from '../security/rate-limits';
import type { Request, Response } from 'express';
import { claimGuestAppointments } from '../account/guest-appointments';
import { db } from '../database/client';
import { sendEmail, assertMailConfigured } from '../mail/email.service';
import { passwordResetEmail, webUrl } from '../mail/templates';
import { consumeAuthToken, issueAuthToken } from './auth-tokens';
import { hashPassword, tokenHash, verifyPassword } from './security';
import {
  accountDisabled,
  authenticated,
  checkOrigin,
  cookieName,
  issueSession,
  phoneUnverifiedMessage,
  safeUser,
  sessionToken,
} from './session';
import { OtpRateLimitError, VerificationService } from './verification.service';
import { assertPhoneAllowed } from '../security/blocked-phones';
import { hashIdentifier, ipHash, requestOrigin } from '../security/client-identity';
import { countRateEvents, rateLimited, recordRateEvent } from '../security/rate-events';

/** Fuerza bruta: intentos fallidos por número (cuenta) y por IP en 15 minutos. */
export const LOGIN_LIMITS = { perPhone: 8, perIp: 30, windowMs: 15 * 60000 };

export const genericRecoveryMessage =
  'Si existe una cuenta verificada asociada a estos datos, recibirás instrucciones para continuar.';
const phoneInUse = () =>
  new ConflictException({
    statusCode: 409,
    code: 'PHONE_IN_USE',
    message: 'Ya existe una cuenta asociada a este número de WhatsApp.',
  });
const emailInUse = () =>
  new ConflictException({
    statusCode: 409,
    code: 'EMAIL_IN_USE',
    message: 'Ya existe una cuenta asociada a este correo.',
  });
const dummyHash = '00000000000000000000000000000000:' + '00'.repeat(64);
/** La contraseña solo se recupera por correo verificado (nunca por WhatsApp). */
export const PASSWORD_RESET_TTL = { EMAIL: 1800 } as const;

/** Normalización definitiva en el backend: equivalentes de un número resuelven al mismo E.164. */
export function serverPhone(value: string) {
  return normalizePhone(value, 'EC');
}

@Controller('api/v1/auth')
export class AuthController {
  constructor(@Inject(VerificationService) private readonly verification: VerificationService) {}

  @Post('register')
  @RateLimit('register')
  async register(@Body() body: unknown, @Req() req: Request) {
    checkOrigin(req);
    const parsed = registrationSchema.safeParse(body);
    const phone = parsed.success ? serverPhone(parsed.data.phone) : null;
    if (!parsed.success || !phone)
      throw new BadRequestException(
        'Revisa nombre, correo, WhatsApp y contraseña (mínimo 12 caracteres)',
      );
    const data = parsed.data;
    await assertPhoneAllowed(phone, 'register');
    if (await db.user.findUnique({ where: { phone } })) throw phoneInUse();
    if (await db.user.findUnique({ where: { email: data.email } })) throw emailInUse();
    // La cuenta queda pendiente dentro del desafío y se crea solo al verificar el número:
    // un registro abandonado no bloquea el teléfono de su verdadero propietario.
    return this.verification.start({
      purpose: 'PHONE_VERIFICATION',
      phone,
      origin: requestOrigin(req),
      registration: {
        firstName: data.firstName,
        lastName: data.lastName,
        name: `${data.firstName} ${data.lastName}`,
        email: data.email,
        passwordHash: await hashPassword(data.password),
      },
    });
  }

  @Post('login')
  @HttpCode(200)
  @RateLimit('login')
  async login(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    checkOrigin(req);
    const parsed = loginSchema.safeParse(body);
    const phone = parsed.success ? serverPhone(parsed.data.phone) : null;
    // Mismo bloqueo exista o no la cuenta: no permite averiguar qué números están registrados.
    const phoneKey = hashIdentifier(`phone:${phone ?? 'invalid'}`);
    const ipKey = ipHash(req);
    const [phoneFailures, ipFailures] = await Promise.all([
      countRateEvents('login_failed_phone', phoneKey, LOGIN_LIMITS.windowMs),
      countRateEvents('login_failed_ip', ipKey, LOGIN_LIMITS.windowMs),
    ]);
    if (phoneFailures >= LOGIN_LIMITS.perPhone || ipFailures >= LOGIN_LIMITS.perIp)
      throw rateLimited(
        'LOGIN_LOCKED',
        'Demasiados intentos fallidos. Espera 15 minutos o recupera tu contraseña.',
        { scope: phoneFailures >= LOGIN_LIMITS.perPhone ? 'account' : 'ip' },
      );
    const user = phone ? await db.user.findUnique({ where: { phone } }) : null;
    const valid = await verifyPassword(
      parsed.success ? parsed.data.password : '',
      user?.passwordHash ?? dummyHash,
    );
    if (!user || !valid) {
      await Promise.all([
        recordRateEvent('login_failed_phone', phoneKey),
        recordRateEvent('login_failed_ip', ipKey),
      ]);
      logEvent('auth.login_failed', {
        reason: 'INVALID_CREDENTIALS',
        status: 401,
        recentFailures: phoneFailures + 1,
      });
      throw new UnauthorizedException({
        statusCode: 401,
        code: 'INVALID_CREDENTIALS',
        message: 'Teléfono o contraseña incorrectos',
      });
    }
    if (user.active === false) {
      logEvent('auth.login_failed', { reason: 'ACCOUNT_DISABLED', status: 403 }, 'warn');
      throw new ForbiddenException(accountDisabled);
    }
    if (user.role === 'CUSTOMER' && !user.phoneVerifiedAt) {
      // Credenciales correctas, número sin verificar: no se crea otra cuenta ni sesión.
      let verification = null;
      let deliveryError: string | null = null;
      try {
        verification = await this.verification.start({
          purpose: 'PHONE_VERIFICATION',
          phone: user.phone,
          userId: user.id,
          origin: requestOrigin(req),
        });
      } catch (error) {
        if (error instanceof OtpRateLimitError) {
          const active = await db.phoneChallenge.findFirst({
            where: {
              userId: user.id,
              purpose: 'PHONE_VERIFICATION',
              consumedAt: null,
              delivered: true,
              expiresAt: { gt: new Date() },
            },
            orderBy: { createdAt: 'desc' },
          });
          if (active)
            verification = {
              verificationId: active.id,
              maskedPhone: maskPhone(user.phone),
              expiresIn: Math.max(0, Math.round((active.expiresAt.getTime() - Date.now()) / 1000)),
              resendAfter: 60,
            };
          else deliveryError = (error.getResponse() as { message: string }).message;
        } else if (error instanceof HttpException) deliveryError = error.message;
        else throw error;
      }
      throw new ForbiddenException({
        statusCode: 403,
        code: 'PHONE_UNVERIFIED',
        message: phoneUnverifiedMessage,
        verification,
        deliveryError,
      });
    }
    await issueSession(user.id, res);
    return db.user.findUniqueOrThrow({ where: { id: user.id }, select: safeUser });
  }

  @Post('phone/verify')
  @HttpCode(200)
  @RateLimit('otpVerify')
  async verifyPhone(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    checkOrigin(req);
    const parsed = verifyPhoneSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Escribe el código de 6 dígitos');
    let result;
    try {
      result = await this.verification.verify(
        parsed.data.verificationId,
        parsed.data.code,
        'PHONE_VERIFICATION',
        async (tx, c) => {
          const now = new Date();
          let userId: string;
          if (c.userId) {
            // Cuenta existente: el número verificado debe seguir siendo el de la cuenta.
            const updated = await tx.user.updateMany({
              where: { id: c.userId, phone: c.phone },
              data: { phoneVerifiedAt: now },
            });
            if (!updated.count) throw new BadRequestException('Inicia una nueva solicitud.');
            userId = c.userId;
          } else {
            if (!c.name || !c.email || !c.passwordHash)
              throw new BadRequestException('Inicia una nueva solicitud.');
            const user = await tx.user.create({
              data: {
                name: c.name,
                firstName: c.firstName,
                lastName: c.lastName,
                phone: c.phone,
                email: c.email,
                passwordHash: c.passwordHash,
                phoneVerifiedAt: now,
              },
            });
            userId = user.id;
          }
          // Solo ahora, con la posesión del número demostrada, se asocian sus reservas.
          const claimed = await claimGuestAppointments(tx, userId, c.phone, now);
          return { userId, claimed };
        },
      );
    } catch (e: any) {
      // Dos registros simultáneos del mismo número: solo uno gana gracias al UNIQUE.
      if (e?.code === 'P2002')
        throw Array.isArray(e.meta?.target) && e.meta.target.includes('email')
          ? emailInUse()
          : phoneInUse();
      throw e;
    }
    await issueSession(result.userId, res);
    const user = await db.user.findUniqueOrThrow({
      where: { id: result.userId },
      select: safeUser,
    });
    return { ...user, claimedAppointments: result.claimed };
  }

  @Post('phone/resend')
  @HttpCode(200)
  @RateLimit('otp')
  async resend(@Body() body: unknown, @Req() req: Request) {
    checkOrigin(req);
    const parsed = resendVerificationSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Solicitud inválida');
    return this.verification.resend(
      parsed.data.verificationId,
      ['PHONE_VERIFICATION'],
      undefined,
      requestOrigin(req),
    );
  }

  @Post('password-reset/email')
  @HttpCode(200)
  @RateLimit('recovery')
  async resetByEmail(@Body() body: unknown, @Req() req: Request) {
    checkOrigin(req);
    const parsed = emailRequestSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Escribe un correo válido');
    // Se comprueba antes de buscar la cuenta para no revelar su existencia con el error.
    assertMailConfigured();
    const user = await db.user.findUnique({ where: { email: parsed.data.email } });
    if (user?.emailVerifiedAt) {
      try {
        const token = await db.$transaction((tx) =>
          issueAuthToken(tx, {
            purpose: 'PASSWORD_RESET',
            userId: user.id,
            channel: 'EMAIL',
            email: parsed.data.email,
            ttlSeconds: PASSWORD_RESET_TTL.EMAIL,
            maxPerHour: 3,
          }),
        );
        await sendEmail({
          to: parsed.data.email,
          kind: 'PASSWORD_RESET',
          userId: user.id,
          message: passwordResetEmail({
            name: user.firstName || user.name,
            url: `${webUrl()}/#restablecer?token=${token}`,
          }),
        });
      } catch {
        // El fallo queda registrado; la respuesta no afirma un envío ni revela la cuenta.
      }
    }
    return { message: genericRecoveryMessage };
  }

  @Post('password-reset/complete')
  @HttpCode(200)
  @RateLimit('recovery')
  async completeReset(@Body() body: unknown, @Req() req: Request) {
    checkOrigin(req);
    const parsed = completeResetSchema.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException('Usa una contraseña de al menos 12 caracteres');
    const passwordHash = await hashPassword(parsed.data.password);
    const ok = await db.$transaction(async (tx) => {
      const token = await consumeAuthToken(tx, parsed.data.token, 'PASSWORD_RESET');
      if (!token) return false;
      // Un enlace por correo solo vale si ese correo sigue siendo el verificado de la cuenta.
      if (
        token.channel === 'EMAIL' &&
        (token.user.email !== token.email || !token.user.emailVerifiedAt)
      )
        return false;
      await tx.user.update({ where: { id: token.userId }, data: { passwordHash } });
      await tx.session.deleteMany({ where: { userId: token.userId } });
      await tx.authToken.updateMany({
        where: { userId: token.userId, purpose: 'PASSWORD_RESET', usedAt: null },
        data: { usedAt: new Date() },
      });
      return true;
    });
    if (!ok) throw new BadRequestException('El enlace caducó o ya se utilizó. Solicita uno nuevo.');
    return { ok: true };
  }

  @Post('email/verify')
  @HttpCode(200)
  @RateLimit('otpVerify')
  async verifyEmail(@Body() body: unknown, @Req() req: Request) {
    checkOrigin(req);
    const parsed = tokenSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Enlace inválido');
    const email = await db.$transaction(async (tx) => {
      const token = await consumeAuthToken(tx, parsed.data.token, 'EMAIL_VERIFICATION');
      // Si el correo cambió después de enviar el enlace, el enlace antiguo no verifica el nuevo.
      if (!token || !token.email || token.user.email !== token.email) return null;
      await tx.user.update({
        where: { id: token.userId },
        data: { emailVerifiedAt: new Date() },
      });
      return token.email;
    });
    if (!email)
      throw new BadRequestException(
        'El enlace caducó, ya se utilizó o pertenece a otro correo. Solicita uno nuevo desde Mi cuenta.',
      );
    return { ok: true, email };
  }

  @Get('me') async me(@Req() req: Request) {
    return authenticated(req);
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    checkOrigin(req);
    await db.session.deleteMany({ where: { tokenHash: tokenHash(sessionToken(req)) } });
    res.clearCookie(cookieName, { path: '/' });
    return { ok: true };
  }
}
