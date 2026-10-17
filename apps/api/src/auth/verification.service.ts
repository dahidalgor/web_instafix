import { BadRequestException, HttpException, Inject, Injectable } from '@nestjs/common';
import type { PhoneChallenge, Prisma } from '@prisma/client';
import { randomInt } from 'node:crypto';
import { maskPhone } from '@instafix/contracts/src/phone';
import { logCommunication } from '../communications/log';
import { db } from '../database/client';
import { ProviderError } from '../integrations/provider-error';
import { WHATSAPP_OTP_PROVIDER, type WhatsAppOtpProvider } from '../whatsapp/otp.provider';
import { hashPassword, verifyPassword } from './security';

/** Cada propósito es independiente: un código de verificación nunca restablece contraseñas. */
export const otpPurposes = ['PHONE_VERIFICATION', 'PASSWORD_RESET', 'PHONE_CHANGE'] as const;
export type OtpPurpose = (typeof otpPurposes)[number];

export const OTP_TTL_SECONDS = 600;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_COOLDOWN_SECONDS = 60;
export const OTP_MAX_PER_HOUR = 5;

type Registration = {
  firstName: string;
  lastName: string;
  name: string;
  email: string;
  passwordHash: string;
};
export type StartInput = {
  purpose: OtpPurpose;
  phone: string;
  userId?: string;
  registration?: Registration;
  /** false para respuestas señuelo: misma forma, sin envío, para no revelar cuentas. */
  deliver?: boolean;
};
export type VerificationTicket = {
  verificationId: string;
  maskedPhone: string;
  expiresIn: number;
  resendAfter: number;
};

export class OtpDeliveryError extends HttpException {
  constructor() {
    super(
      'No pudimos enviar el código por WhatsApp. Inténtalo de nuevo en unos minutos.',
      503,
    );
  }
}
export class OtpRateLimitError extends HttpException {
  constructor(retryAfter: number) {
    super(
      {
        statusCode: 429,
        code: 'OTP_RATE_LIMIT',
        retryAfter,
        message:
          retryAfter > OTP_COOLDOWN_SECONDS
            ? 'Alcanzaste el máximo de códigos por hora. Inténtalo más tarde.'
            : `Espera ${retryAfter} segundos antes de solicitar otro código.`,
      },
      429,
    );
  }
}
export const invalidOtpMessage = 'Código incorrecto, caducado o ya utilizado. Solicita uno nuevo.';

const newCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

@Injectable()
export class VerificationService {
  constructor(@Inject(WHATSAPP_OTP_PROVIDER) private readonly provider: WhatsAppOtpProvider) {}

  /** Genera, guarda (hash con sal) y envía un OTP aplicando cooldown y límite por hora. */
  async start(input: StartInput, now = new Date()): Promise<VerificationTicket> {
    const deliver = input.deliver !== false;
    const code = newCode();
    const codeHash = await hashPassword(code);
    let messageId: string | null = null;
    try {
      const challenge = await db.$transaction(
        async (tx) => {
          // El bloqueo por teléfono evita saltarse los límites con peticiones simultáneas.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`otp:${input.phone}`}))`;
          const recent = await tx.phoneChallenge.findMany({
            where: { phone: input.phone, createdAt: { gt: new Date(now.getTime() - 3600000) } },
            orderBy: { createdAt: 'desc' },
          });
          const last = recent[0];
          const cooldown = last
            ? Math.ceil(
                (last.createdAt.getTime() + OTP_COOLDOWN_SECONDS * 1000 - now.getTime()) / 1000,
              )
            : 0;
          if (cooldown > 0) throw new OtpRateLimitError(cooldown);
          if (recent.length >= OTP_MAX_PER_HOUR) {
            const oldest = recent[recent.length - 1];
            throw new OtpRateLimitError(
              Math.max(
                OTP_COOLDOWN_SECONDS + 1,
                Math.ceil((oldest.createdAt.getTime() + 3600000 - now.getTime()) / 1000),
              ),
            );
          }
          const created = await tx.phoneChallenge.create({
            data: {
              purpose: input.purpose,
              phone: input.phone,
              userId: input.userId,
              codeHash,
              expiresAt: new Date(now.getTime() + OTP_TTL_SECONDS * 1000),
              delivered: deliver,
              createdAt: now,
              ...input.registration,
            },
          });
          if (deliver) {
            // Si el proveedor falla, la transacción se revierte: no queda un código "enviado".
            messageId = (await this.provider.sendAuthenticationCode(input.phone, code)).messageId;
            await tx.phoneChallenge.update({
              where: { id: created.id },
              data: { providerMessageId: messageId },
            });
          }
          // Reenviar invalida los códigos anteriores del mismo número y propósito.
          await tx.phoneChallenge.updateMany({
            where: {
              phone: input.phone,
              purpose: input.purpose,
              id: { not: created.id },
              consumedAt: null,
            },
            data: { consumedAt: now, passwordHash: null },
          });
          return created;
        },
        { timeout: 30000 },
      );
      if (deliver)
        await logCommunication({
          channel: 'WHATSAPP',
          provider: this.provider.name,
          kind: `OTP_${input.purpose}`,
          recipient: input.phone,
          status: 'ACCEPTED',
          providerMessageId: messageId,
          userId: input.userId,
        });
      return {
        verificationId: challenge.id,
        maskedPhone: maskPhone(input.phone),
        expiresIn: OTP_TTL_SECONDS,
        resendAfter: OTP_COOLDOWN_SECONDS,
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      await logCommunication({
        channel: 'WHATSAPP',
        provider: this.provider.name,
        kind: `OTP_${input.purpose}`,
        recipient: input.phone,
        status: 'FAILED',
        error: error instanceof ProviderError ? error.message : 'Error inesperado al enviar',
        userId: input.userId,
      });
      throw new OtpDeliveryError();
    }
  }

  /** Reenvía con un código nuevo conservando el propósito y los datos de la solicitud. */
  async resend(verificationId: string, purposes: readonly OtpPurpose[], userId?: string) {
    const c = await db.phoneChallenge.findUnique({ where: { id: verificationId } });
    if (
      !c ||
      !purposes.includes(c.purpose as OtpPurpose) ||
      c.consumedAt ||
      c.createdAt.getTime() < Date.now() - 86400000 ||
      (userId !== undefined && c.userId !== userId)
    )
      throw new BadRequestException('Inicia una nueva solicitud.');
    return this.start({
      purpose: c.purpose as OtpPurpose,
      phone: c.phone,
      userId: c.userId ?? undefined,
      deliver: c.delivered,
      registration:
        c.passwordHash && c.name && c.email && c.firstName && c.lastName
          ? {
              firstName: c.firstName,
              lastName: c.lastName,
              name: c.name,
              email: c.email,
              passwordHash: c.passwordHash,
            }
          : undefined,
    });
  }

  /**
   * Consume el código en una transacción: uso único, caducidad, límite de intentos y
   * propósito. La acción se ejecuta en la misma transacción que el consumo.
   */
  async verify<T>(
    verificationId: string,
    code: string,
    purpose: OtpPurpose,
    action: (tx: Prisma.TransactionClient, challenge: PhoneChallenge) => Promise<T>,
    now = new Date(),
  ): Promise<T> {
    const result = await db.$transaction(async (tx) => {
      const identity = await tx.phoneChallenge.findUnique({
        where: { id: verificationId },
        select: { phone: true },
      });
      if (!identity) return { invalid: true } as const;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`otp:${identity.phone}`}))`;
      const challenge = await tx.phoneChallenge.findUnique({ where: { id: verificationId } });
      if (
        !challenge ||
        challenge.purpose !== purpose ||
        challenge.consumedAt ||
        !challenge.delivered ||
        challenge.expiresAt <= now ||
        challenge.attempts >= OTP_MAX_ATTEMPTS
      )
        return { invalid: true } as const;
      if (!(await verifyPassword(code, challenge.codeHash))) {
        // El intento fallido se confirma antes de responder con el error.
        await tx.phoneChallenge.update({
          where: { id: challenge.id },
          data: { attempts: { increment: 1 } },
        });
        return { invalid: true } as const;
      }
      await tx.phoneChallenge.update({
        where: { id: challenge.id },
        data: { consumedAt: now, passwordHash: null },
      });
      return { value: await action(tx, challenge) };
    });
    if ('invalid' in result) throw new BadRequestException(invalidOtpMessage);
    return result.value;
  }
}
