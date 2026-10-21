import { HttpException } from '@nestjs/common';
import { logEvent } from '../common/log-event';
import { db } from '../database/client';

/** Contadores de seguridad persistentes (sobreviven reinicios y valen con varias instancias). */
export async function recordRateEvent(scope: string, key: string) {
  await db.rateEvent.create({ data: { scope, key } });
}
export async function countRateEvents(scope: string, key: string, windowMs: number) {
  return db.rateEvent.count({
    where: { scope, key, createdAt: { gt: new Date(Date.now() - windowMs) } },
  });
}
/** Limpieza oportunista de contadores antiguos. */
export async function pruneRateEvents(olderThanMs = 7 * 86400000) {
  await db.rateEvent.deleteMany({
    where: { createdAt: { lt: new Date(Date.now() - olderThanMs) } },
  });
}

export class TooManyRequests extends HttpException {
  constructor(code: string, message: string, retryAfter?: number) {
    super({ statusCode: 429, code, message, ...(retryAfter ? { retryAfter } : {}) }, 429);
  }
}

/** 429 registrado (sin datos personales): para detectar abuso. */
export function rateLimited(code: string, message: string, data: Record<string, unknown> = {}) {
  logEvent('security.rate_limited', { code, ...data }, 'warn');
  return new TooManyRequests(code, message);
}
