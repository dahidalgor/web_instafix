import { BadRequestException, HttpException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { randomInt } from 'node:crypto';
import { db } from '../database/client';
import { sendCode } from './email';
import { hashPassword, verifyPassword } from './security';

type ChallengeInput = {
  email: string;
  purpose: 'REGISTER' | 'RESET';
  name?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  passwordHash?: string;
  userId?: string;
};
export async function createChallenge(data: ChallengeInput, deliver = true, mailer = sendCode) {
  const code = String(randomInt(100000, 1000000));
  const codeHash = await hashPassword(code);
  return db.$transaction(
    async (tx) => {
      // El bloqueo evita saltarse el límite mediante peticiones simultáneas.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${data.email}))`;
      const recent = await tx.emailChallenge.findMany({
        where: { email: data.email, createdAt: { gt: new Date(Date.now() - 3600000) } },
        orderBy: { createdAt: 'desc' },
      });
      if (recent.length >= 5 || (recent[0] && recent[0].createdAt.getTime() > Date.now() - 60000)) {
        throw new HttpException('Espera antes de solicitar otro código. Máximo 5 por hora.', 429);
      }
      const challenge = await tx.emailChallenge.create({
        data: { ...data, codeHash, expiresAt: new Date(Date.now() + 600000) },
      });
      if (deliver) await mailer(data.email, code, data.purpose);
      await tx.emailChallenge.updateMany({
        where: {
          email: data.email,
          purpose: data.purpose,
          id: { not: challenge.id },
          consumedAt: null,
        },
        data: { consumedAt: new Date(), passwordHash: null },
      });
      return { challengeId: challenge.id, expiresIn: 600 };
    },
    { timeout: 30000 },
  );
}

export async function consumeChallenge<T>(
  id: string,
  code: string,
  purpose: 'REGISTER' | 'RESET',
  action: (
    tx: Prisma.TransactionClient,
    challenge: NonNullable<Awaited<ReturnType<typeof db.emailChallenge.findUnique>>>,
  ) => Promise<T>,
): Promise<T> {
  const result = await db.$transaction(async (tx) => {
    const identity = await tx.emailChallenge.findUnique({ where: { id }, select: { email: true } });
    if (!identity) return { invalid: true } as const;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${identity.email}))`;
    const challenge = await tx.emailChallenge.findUnique({ where: { id } });
    if (
      !challenge ||
      challenge.purpose !== purpose ||
      challenge.consumedAt ||
      challenge.expiresAt <= new Date() ||
      challenge.attempts >= 5
    )
      return { invalid: true } as const;
    if (!(await verifyPassword(code, challenge.codeHash))) {
      // Se confirma el intento fallido antes de lanzar el error HTTP.
      await tx.emailChallenge.update({ where: { id }, data: { attempts: { increment: 1 } } });
      return { invalid: true } as const;
    }
    await tx.emailChallenge.update({
      where: { id },
      data: { consumedAt: new Date(), passwordHash: null },
    });
    return { value: await action(tx, challenge) };
  });
  if ('invalid' in result)
    throw new BadRequestException(
      'Código incorrecto, caducado o ya utilizado. Solicita uno nuevo.',
    );
  return result.value;
}
