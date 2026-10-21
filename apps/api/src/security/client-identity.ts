import { createHmac, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import type { Request, Response } from 'express';
import { sessionToken } from '../auth/session';
import { tokenHash } from '../auth/security';

/**
 * Identidad técnica de quien hace la petición, para límites y presupuestos. Sin fingerprinting:
 * solo la IP (con hash) y una cookie aleatoria propia. Nunca se guarda la IP en claro.
 */

/**
 * IP real del cliente. Producción: Cloudflare → Caddy → API. Caddy sobrescribe siempre
 * X-Real-IP con {client_ip}, que solo acepta CF-Connecting-IP si la conexión viene de un rango
 * de Cloudflare (trusted_proxies en el Caddyfile). Un X-Real-IP enviado por el cliente nunca
 * llega a la API, y X-Forwarded-For no se usa: lo puede escribir cualquiera.
 */
export function clientIp(req: Pick<Request, 'headers' | 'socket' | 'ip'>): string {
  if (process.env.NODE_ENV === 'production') {
    const header = req.headers['x-real-ip'];
    const value = (Array.isArray(header) ? header[0] : header)?.trim();
    if (value && isIP(value)) return value;
  }
  const peer = req.socket?.remoteAddress || req.ip || 'unknown';
  return peer.replace(/^::ffff:/, '');
}

const hashKey = () =>
  // Clave del servidor: el hash no se puede invertir probando todas las IPv4 sin conocerla.
  process.env.IP_HASH_SECRET || process.env.DATABASE_URL || 'instafix-local';
export const hashIdentifier = (value: string) =>
  createHmac('sha256', hashKey()).update(value).digest('hex').slice(0, 32);
export const ipHash = (req: Pick<Request, 'headers' | 'socket' | 'ip'>) =>
  hashIdentifier(`ip:${clientIp(req)}`);

export const clientCookie = 'instafix_client';
function readCookie(req: Request, name: string) {
  return (
    req.headers.cookie
      ?.split(';')
      .map((c) => c.trim())
      .find((c) => c.startsWith(`${name}=`))
      ?.slice(name.length + 1) ?? ''
  );
}

/**
 * Clave de sesión del cliente: la sesión iniciada o, para invitados, una cookie aleatoria de
 * Instafix (httpOnly). Con `res`, se crea si falta. Borrar cookies crea otra sesión: por eso
 * los presupuestos también se aplican por teléfono, cuenta, cita e IP.
 */
export function clientSessionKey(req: Request, res?: Response): string | null {
  const session = sessionToken(req);
  if (session) return `s:${tokenHash(session).slice(0, 32)}`;
  let value = readCookie(req, clientCookie);
  if (!/^[a-f0-9]{32}$/.test(value)) {
    if (!res) return null;
    value = randomBytes(16).toString('hex');
    res.cookie(clientCookie, value, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 30 * 86400000,
    });
  }
  return `c:${tokenHash(value).slice(0, 32)}`;
}

export type RequestOrigin = { sessionKey: string | null; ipHash: string };
export const requestOrigin = (req: Request, res?: Response): RequestOrigin => ({
  sessionKey: clientSessionKey(req, res),
  ipHash: ipHash(req),
});
