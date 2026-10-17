import {
  changeEmailSchema,
  changePasswordSchema,
  changePhoneSchema,
  verifyPhoneSchema,
} from '@instafix/contracts';
import { maskEmail } from '@instafix/contracts/src/phone';
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  HttpCode,
  Post,
  Req,
  UnauthorizedException,
  Inject,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { serverPhone } from '../auth/auth.controller';
import { issueAuthToken } from '../auth/auth-tokens';
import { hashPassword, tokenHash, verifyPassword } from '../auth/security';
import { authenticated, checkOrigin, safeUser, sessionToken } from '../auth/session';
import { VerificationService } from '../auth/verification.service';
import { db } from '../database/client';
import { assertMailConfigured, sendEmail } from '../mail/email.service';
import { emailVerificationEmail, webUrl } from '../mail/templates';
import { claimGuestAppointments } from './guest-appointments';

const EMAIL_VERIFICATION_TTL = 86400;

async function requirePassword(userId: string, password: string) {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
  if (!(await verifyPassword(password, user.passwordHash)))
    throw new UnauthorizedException('La contraseña actual no es correcta.');
  return user;
}

@Controller('api/v1/my')
export class SecurityController {
  constructor(@Inject(VerificationService) private readonly verification: VerificationService) {}

  /** Verificación opcional del correo: Instafix → Brevo → enlace de un solo uso. */
  @Post('email/verification')
  @HttpCode(200)
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  async sendEmailVerification(@Req() req: Request) {
    checkOrigin(req);
    const session = await authenticated(req);
    const user = await db.user.findUniqueOrThrow({ where: { id: session.id } });
    if (!user.email) throw new BadRequestException('Añade un correo a tu cuenta.');
    if (user.emailVerifiedAt) return { alreadyVerified: true, maskedEmail: maskEmail(user.email) };
    assertMailConfigured();
    const token = await db.$transaction((tx) =>
      issueAuthToken(tx, {
        purpose: 'EMAIL_VERIFICATION',
        userId: user.id,
        email: user.email!,
        channel: 'EMAIL',
        ttlSeconds: EMAIL_VERIFICATION_TTL,
        maxPerHour: 5,
      }),
    );
    // Si Brevo no acepta el mensaje, sendEmail lanza un error y no se afirma el envío.
    const result = await sendEmail({
      to: user.email,
      kind: 'EMAIL_VERIFICATION',
      userId: user.id,
      message: emailVerificationEmail({
        name: user.firstName || user.name,
        url: `${webUrl()}/#verificar-correo?token=${token}`,
      }),
    });
    return { accepted: true, maskedEmail: maskEmail(user.email), messageId: !!result.messageId };
  }

  /** Cambiar el correo lo deja sin verificar hasta confirmar el nuevo. */
  @Post('email')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async changeEmail(@Body() body: unknown, @Req() req: Request) {
    checkOrigin(req);
    const session = await authenticated(req);
    const parsed = changeEmailSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Escribe un correo válido');
    const user = await requirePassword(session.id, parsed.data.password);
    if (user.email === parsed.data.email)
      throw new BadRequestException('Ese ya es el correo de tu cuenta.');
    try {
      return await db.$transaction(async (tx) => {
        await tx.authToken.updateMany({
          where: { userId: user.id, purpose: 'EMAIL_VERIFICATION', usedAt: null },
          data: { usedAt: new Date() },
        });
        // Los enlaces de recuperación por el correo anterior dejan de ser válidos.
        await tx.authToken.updateMany({
          where: { userId: user.id, purpose: 'PASSWORD_RESET', channel: 'EMAIL', usedAt: null },
          data: { usedAt: new Date() },
        });
        return tx.user.update({
          where: { id: user.id },
          data: { email: parsed.data.email, emailVerifiedAt: null },
          select: safeUser,
        });
      });
    } catch (e: any) {
      if (e?.code === 'P2002')
        throw new ConflictException('Ya existe una cuenta asociada a este correo.');
      throw e;
    }
  }

  /** Paso 1: comprobar unicidad y enviar OTP al NUEVO número. El número no cambia todavía. */
  @Post('phone/change')
  @HttpCode(200)
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  async startPhoneChange(@Body() body: unknown, @Req() req: Request) {
    checkOrigin(req);
    const session = await authenticated(req);
    const parsed = changePhoneSchema.safeParse(body);
    const phone = parsed.success ? serverPhone(parsed.data.phone) : null;
    if (!parsed.success || !phone)
      throw new BadRequestException('Revisa el número y el país seleccionado.');
    const user = await requirePassword(session.id, parsed.data.password);
    if (user.phone === phone) throw new BadRequestException('Ese ya es tu número verificado.');
    if (await db.user.findUnique({ where: { phone } }))
      throw new ConflictException('Ya existe una cuenta asociada a este número de WhatsApp.');
    return this.verification.start({ purpose: 'PHONE_CHANGE', phone, userId: user.id });
  }

  @Post('phone/change/resend')
  @HttpCode(200)
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  async resendPhoneChange(@Body() body: unknown, @Req() req: Request) {
    checkOrigin(req);
    const session = await authenticated(req);
    const parsed = verifyPhoneSchema.pick({ verificationId: true }).safeParse(body);
    if (!parsed.success) throw new BadRequestException('Solicitud inválida');
    return this.verification.resend(parsed.data.verificationId, ['PHONE_CHANGE'], session.id);
  }

  /** Paso 2: con el OTP del nuevo número se actualiza el teléfono y su verificación. */
  @Post('phone/change/verify')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async verifyPhoneChange(@Body() body: unknown, @Req() req: Request) {
    checkOrigin(req);
    const session = await authenticated(req);
    const parsed = verifyPhoneSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Escribe el código de 6 dígitos');
    try {
      return await this.verification.verify(
        parsed.data.verificationId,
        parsed.data.code,
        'PHONE_CHANGE',
        async (tx, c) => {
          if (c.userId !== session.id) throw new BadRequestException('Inicia una nueva solicitud.');
          const now = new Date();
          const user = await tx.user.update({
            where: { id: session.id },
            data: { phone: c.phone, phoneVerifiedAt: now },
            select: safeUser,
          });
          // Las recuperaciones por WhatsApp pendientes eran para el número anterior.
          await tx.authToken.updateMany({
            where: { userId: session.id, purpose: 'PASSWORD_RESET', usedAt: null },
            data: { usedAt: now },
          });
          const claimed = await claimGuestAppointments(tx, session.id, c.phone, now);
          return { ...user, claimedAppointments: claimed };
        },
      );
    } catch (e: any) {
      if (e?.code === 'P2002')
        throw new ConflictException('Ya existe una cuenta asociada a este número de WhatsApp.');
      throw e;
    }
  }

  @Post('password')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async changePassword(@Body() body: unknown, @Req() req: Request) {
    checkOrigin(req);
    const session = await authenticated(req);
    const parsed = changePasswordSchema.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException('Usa una contraseña nueva de al menos 12 caracteres');
    await requirePassword(session.id, parsed.data.currentPassword);
    const passwordHash = await hashPassword(parsed.data.password);
    await db.$transaction(async (tx) => {
      await tx.user.update({ where: { id: session.id }, data: { passwordHash } });
      // Se conserva la sesión actual; las demás se cierran.
      await tx.session.deleteMany({
        where: { userId: session.id, tokenHash: { not: tokenHash(sessionToken(req)) } },
      });
    });
    return { ok: true };
  }
}
