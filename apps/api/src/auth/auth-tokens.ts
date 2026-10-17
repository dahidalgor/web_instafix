import { HttpException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { newToken, tokenHash } from './security';

export type AuthTokenPurpose = 'PASSWORD_RESET' | 'EMAIL_VERIFICATION';
type Client = Prisma.TransactionClient;

/**
 * Token aleatorio de un solo uso, distinto del token de sesión. Solo se guarda su hash.
 * Aplica cooldown y máximo por hora por usuario y propósito.
 */
export async function issueAuthToken(
  tx: Client,
  input: {
    purpose: AuthTokenPurpose;
    userId: string;
    ttlSeconds: number;
    email?: string;
    channel: 'WHATSAPP' | 'EMAIL';
    maxPerHour?: number;
    cooldownSeconds?: number;
  },
  now = new Date(),
) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`token:${input.purpose}:${input.userId}`}))`;
  if (input.maxPerHour) {
    const recent = await tx.authToken.findMany({
      where: {
        userId: input.userId,
        purpose: input.purpose,
        channel: input.channel,
        createdAt: { gt: new Date(now.getTime() - 3600000) },
      },
      orderBy: { createdAt: 'desc' },
    });
    const cooldown = input.cooldownSeconds ?? 60;
    if (
      recent.length >= input.maxPerHour ||
      (recent[0] && recent[0].createdAt.getTime() > now.getTime() - cooldown * 1000)
    )
      throw new HttpException(
        {
          statusCode: 429,
          code: 'TOKEN_RATE_LIMIT',
          message: 'Espera antes de solicitar otro enlace.',
        },
        429,
      );
  }
  const token = newToken();
  // Un enlace nuevo invalida los anteriores del mismo propósito.
  await tx.authToken.updateMany({
    where: { userId: input.userId, purpose: input.purpose, usedAt: null },
    data: { usedAt: now },
  });
  await tx.authToken.create({
    data: {
      tokenHash: tokenHash(token),
      purpose: input.purpose,
      userId: input.userId,
      email: input.email,
      channel: input.channel,
      expiresAt: new Date(now.getTime() + input.ttlSeconds * 1000),
      createdAt: now,
    },
  });
  return token;
}

/** Marca el token como usado de forma atómica; null si no existe, caducó o ya se usó. */
export async function consumeAuthToken(
  tx: Client,
  token: string,
  purpose: AuthTokenPurpose,
  now = new Date(),
) {
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const hash = tokenHash(token);
  const used = await tx.authToken.updateMany({
    where: { tokenHash: hash, purpose, usedAt: null, expiresAt: { gt: now } },
    data: { usedAt: now },
  });
  if (!used.count) return null;
  return tx.authToken.findUniqueOrThrow({ where: { tokenHash: hash }, include: { user: true } });
}
