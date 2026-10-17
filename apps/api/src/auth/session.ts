import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { isAllowedOrigin } from '../config/environment';
import { db } from '../database/client';
import { newToken, tokenHash } from './security';
export const safeUser = {
  id: true,
  name: true,
  firstName: true,
  lastName: true,
  email: true,
  phone: true,
  role: true,
  phoneVerifiedAt: true,
  emailVerifiedAt: true,
} as const;
export const phoneUnverifiedMessage = 'Verifica tu WhatsApp para continuar.';
export const cookieName = 'instafix_session';
// Las operaciones con cookies verifican el origen antes de modificar datos.
export function checkOrigin(req: Request) {
  if (!isAllowedOrigin(req.headers.origin))
    throw new ForbiddenException(
      process.env.NODE_ENV === 'production'
        ? 'Origen no permitido'
        : `Origen no permitido: ${req.headers.origin ?? '(sin cabecera Origin)'}. Añádelo a ALLOWED_ORIGINS en .env.`,
    );
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
  // Una cuenta de cliente solo está activa después de demostrar que controla su WhatsApp.
  // Sesiones anteriores a este requisito vuelven al inicio de sesión para verificarse.
  if (session.user.role === 'CUSTOMER' && !session.user.phoneVerifiedAt)
    throw new UnauthorizedException({
      statusCode: 401,
      code: 'PHONE_UNVERIFIED',
      message: phoneUnverifiedMessage,
    });
  return session.user;
}
export async function issueSession(userId: string, res: Response) {
  // El llamador garantiza que la cuenta de cliente ya verificó su WhatsApp.
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
