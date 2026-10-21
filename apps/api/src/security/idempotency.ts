import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { db } from '../database/client';

const KEY = /^[A-Za-z0-9_-]{8,100}$/;
/** Cabecera Idempotency-Key enviada por la web (una por acción del usuario). */
export function idempotencyKey(req: Request) {
  const value = req.headers['idempotency-key'];
  const key = Array.isArray(value) ? value[0] : value;
  return key && KEY.test(key) ? key : null;
}

const inProgress = () =>
  new ConflictException({
    statusCode: 409,
    code: 'REQUEST_IN_PROGRESS',
    message: 'Ya estamos procesando esta solicitud. Espera unos segundos.',
  });

/**
 * Ejecuta `fn` una sola vez por clave: un reintento con la misma clave devuelve la respuesta
 * guardada sin repetir la acción ni sus avisos; uno simultáneo recibe 409. Si `fn` falla, la
 * clave se libera para poder reintentar. Sin clave, se ejecuta normalmente.
 */
export async function idempotent<T>(key: string | null, fn: () => Promise<T>, ttlMs = 86400000) {
  if (!key) return fn();
  const now = new Date();
  await db.idempotencyRecord.deleteMany({ where: { key, expiresAt: { lt: now } } });
  try {
    await db.idempotencyRecord.create({
      data: { key, status: 'IN_PROGRESS', expiresAt: new Date(now.getTime() + ttlMs) },
    });
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'))
      throw error;
    const existing = await db.idempotencyRecord.findUnique({ where: { key } });
    if (existing?.status === 'DONE') return existing.response as T;
    throw inProgress();
  }
  try {
    const result = await fn();
    await db.idempotencyRecord.update({
      where: { key },
      data: { status: 'DONE', response: JSON.parse(JSON.stringify(result ?? null)) },
    });
    return result;
  } catch (error) {
    await db.idempotencyRecord.deleteMany({ where: { key, status: 'IN_PROGRESS' } });
    throw error;
  }
}

/**
 * Una sola operación a la vez sobre un recurso (p. ej. reprogramar y cancelar la misma cita en
 * paralelo): la segunda recibe 409 en lugar de llamar dos veces a Cal.com y avisar dos veces.
 * Caduca sola si el proceso se interrumpe.
 */
export async function exclusive<T>(name: string, fn: () => Promise<T>, ttlMs = 120000) {
  const key = `lock:${name}`;
  const now = new Date();
  await db.idempotencyRecord.deleteMany({ where: { key, expiresAt: { lt: now } } });
  try {
    await db.idempotencyRecord.create({
      data: { key, status: 'IN_PROGRESS', expiresAt: new Date(now.getTime() + ttlMs) },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
      throw inProgress();
    throw error;
  }
  try {
    return await fn();
  } finally {
    await db.idempotencyRecord.deleteMany({ where: { key } });
  }
}
