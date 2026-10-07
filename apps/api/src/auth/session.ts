import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { allowedOrigins } from '../config/environment';
import { db } from '../database/client';
import { newToken, tokenHash } from './security';
export const safeUser = {
  id: true,
  name: true,
  phone: true,
  role: true,
  phoneVerifiedAt: true,
} as const;
export const cookieName = 'instafix_session';
// Las operaciones con cookies verifican el origen antes de modificar datos.
export function checkOrigin(req: Request) {
  const allowed = allowedOrigins();
  if (!req.headers.origin || !allowed.includes(req.headers.origin))
    throw new ForbiddenException('Origen no permitido');
}
export function sessionToken(req: Request) {
  return (
    req.headers.cookie
      ?.split(';')
      .map((c) => c.trim())
      .find((c) => c.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1) ?? ''
  );
}
export async function authenticated(req: Request, admin = false) {
  // El token completo solo existe en la cookie; PostgreSQL conserva su hash.
  const session = await db.session.findUnique({
    where: { tokenHash: tokenHash(sessionToken(req)) },
    include: { user: { select: safeUser } },
  });
  if (!session || session.expiresAt <= new Date()) throw new UnauthorizedException('Inicia sesión');
  if (admin && session.user.role !== 'ADMIN') throw new ForbiddenException('Acceso restringido');
  return session.user;
}
export async function issueSession(userId: string, res: Response) {
  const token = newToken();
  await db.session.create({
    data: { userId, tokenHash: tokenHash(token), expiresAt: new Date(Date.now() + 86400000) },
  });
  res.cookie(cookieName, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge: 86400000,
  });
}
