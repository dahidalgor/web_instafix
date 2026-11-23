import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { isAllowedOrigin } from '../config/environment';
import { db } from '../database/client';
import { newToken, tokenHash } from './security';
import { logEvent } from '../common/log-event';
export const safeUser = {
  id: true,
  name: true,
  firstName: true,
  lastName: true,
  email: true,
  phone: true,
  role: true,
  active: true,
  phoneVerifiedAt: true,
  emailVerifiedAt: true,
} as const;
export const phoneUnverifiedMessage = 'Verifica tu WhatsApp para continuar.';
export const accountDisabled = {
  statusCode: 403,
  code: 'ACCOUNT_DISABLED',
  message: 'Tu acceso está desactivado. Contacta con el administrador.',
};
export const cookieName = 'instafix_session';
/**
 * Equipo (administración y técnicos): sesión «como en una app». No caduca mientras se use: cada
 * uso la extiende (como mucho una escritura al día) y solo vence tras STAFF_SESSION_IDLE_MS sin
 * abrir el panel, al cerrar sesión o al cambiar la contraseña. Clientes: 24 h, como antes.
 */
export const STAFF_SESSION_IDLE_MS = 180 * 86400000;
const CUSTOMER_SESSION_MS = 86400000;
const SESSION_RENEW_AFTER_MS = 86400000;
const isStaffRole = (role: string) => role === 'ADMIN' || role === 'TECHNICIAN';
const sessionCookie = (maxAge: number) => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict' as const,
  path: '/',
  maxAge,
});
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
  const now = Date.now();
  if (!session || session.expiresAt.getTime() <= now)
    throw new UnauthorizedException('Inicia sesión');
  // Equipo en uso: se renueva el plazo (y la cookie) si pasó más de un día desde la última vez.
  if (
    isStaffRole(session.user.role) &&
    session.user.active !== false &&
    session.expiresAt.getTime() - now < STAFF_SESSION_IDLE_MS - SESSION_RENEW_AFTER_MS
  ) {
    await db.session.updateMany({
      where: { tokenHash: session.tokenHash, expiresAt: session.expiresAt },
      data: { expiresAt: new Date(now + STAFF_SESSION_IDLE_MS) },
    });
    req.res?.cookie(cookieName, sessionToken(req), sessionCookie(STAFF_SESSION_IDLE_MS));
  }
  // Una cuenta desactivada pierde el acceso aunque conserve una sesión abierta. Solo un
  // «false» explícito desactiva: un valor ausente es un error de esquema, no una cuenta inactiva.
  if (session.user.active === false) {
    logEvent(
      'auth.denied',
      { reason: 'ACCOUNT_DISABLED', endpoint: req.path, status: 403 },
      'warn',
    );
    throw new ForbiddenException(accountDisabled);
  }
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
  const user = await db.user.findUnique({ where: { id: userId }, select: { role: true } });
  const lifetime = user && isStaffRole(user.role) ? STAFF_SESSION_IDLE_MS : CUSTOMER_SESSION_MS;
  await db.session.create({
    data: { userId, tokenHash: tokenHash(token), expiresAt: new Date(Date.now() + lifetime) },
  });
  res.cookie(cookieName, token, sessionCookie(lifetime));
}

export type StaffUser = Awaited<ReturnType<typeof authenticated>> & {
  role: 'ADMIN' | 'TECHNICIAN';
};
/**
 * Equipo de Instafix (administradores y técnicos). La identidad sale siempre de la sesión:
 * ningún endpoint del equipo acepta un id de técnico enviado por el navegador.
 */
export async function authenticatedStaff(req: Request): Promise<StaffUser> {
  const user = await authenticated(req);
  if (user.role !== 'ADMIN' && user.role !== 'TECHNICIAN')
    throw new ForbiddenException('Acceso restringido');
  return user as StaffUser;
}
