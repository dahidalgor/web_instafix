import { ForbiddenException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { logEvent } from '../common/log-event';
import { db } from '../database/client';

type Client = Prisma.TransactionClient | typeof db;

export async function isPhoneBlocked(phone: string | null | undefined, client: Client = db) {
  if (!phone) return false;
  return Boolean(
    await client.blockedPhone.findUnique({ where: { phone }, select: { phone: true } }),
  );
}

/** Mensaje público: nunca revela el motivo interno del bloqueo. */
export const blockedMessage =
  'No podemos procesar esta solicitud con este número. Si crees que es un error, escríbenos.';

/** Rechaza flujos sensibles (citas, cuentas, OTP) de un número bloqueado por administración. */
export async function assertPhoneAllowed(phone: string | null | undefined, flow: string) {
  if (!(await isPhoneBlocked(phone))) return;
  logEvent('security.blocked_phone', { flow }, 'warn');
  throw new ForbiddenException({ statusCode: 403, code: 'PHONE_BLOCKED', message: blockedMessage });
}
