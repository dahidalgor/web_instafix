import { ExecutionContext, Injectable } from '@nestjs/common';
import {
  SkipThrottle,
  Throttle,
  ThrottlerGuard,
  type ThrottlerLimitDetail,
} from '@nestjs/throttler';
import type { Request } from 'express';
import { logEvent } from '../common/log-event';
import { clientIp } from './client-identity';

const minute = 60_000;
const hour = 3_600_000;
/**
 * Límites por tipo de operación (por IP real y ruta). Dos ventanas: «default» frena ráfagas y
 * «long» limita el volumen por hora. Son la segunda capa: Cloudflare filtra antes.
 * Los límites de negocio (por teléfono, cuenta, cita, sesión) se aplican además en los servicios.
 */
export const rateLimits = {
  /** Navegación y lecturas de la API pública. */
  publicApi: { default: { limit: 120, ttl: minute }, long: { limit: 3000, ttl: hour } },
  /** Disponibilidad (consulta Cal.com, con caché de 30 s). */
  slots: { default: { limit: 30, ttl: minute }, long: { limit: 400, ttl: hour } },
  login: { default: { limit: 10, ttl: minute }, long: { limit: 40, ttl: hour } },
  register: { default: { limit: 5, ttl: minute }, long: { limit: 15, ttl: hour } },
  booking: { default: { limit: 5, ttl: minute }, long: { limit: 12, ttl: hour } },
  reschedule: { default: { limit: 5, ttl: minute }, long: { limit: 15, ttl: hour } },
  cancel: { default: { limit: 5, ttl: minute }, long: { limit: 20, ttl: hour } },
  /** Solicitar o reenviar un OTP (WhatsApp facturable). */
  otp: { default: { limit: 3, ttl: minute }, long: { limit: 10, ttl: hour } },
  otpVerify: { default: { limit: 10, ttl: minute }, long: { limit: 40, ttl: hour } },
  recovery: { default: { limit: 5, ttl: minute }, long: { limit: 15, ttl: hour } },
  /** Correos u otros avisos pedidos por el usuario (verificación de correo, pruebas). */
  communications: { default: { limit: 3, ttl: minute }, long: { limit: 10, ttl: hour } },
  /** Acciones del equipo (sesión de ADMIN/TECHNICIAN). */
  staff: { default: { limit: 60, ttl: minute }, long: { limit: 1500, ttl: hour } },
  /** Registrar o quitar dispositivos de notificaciones push del equipo. */
  push: { default: { limit: 10, ttl: minute }, long: { limit: 60, ttl: hour } },
  analytics: { default: { limit: 60, ttl: minute }, long: { limit: 1500, ttl: hour } },
} as const;
export type RateLimitPolicy = keyof typeof rateLimits;

export const RateLimit = (policy: RateLimitPolicy) => Throttle(rateLimits[policy]);
/** Webhooks firmados y medios estáticos: los reintentos del proveedor no se limitan por IP. */
export const NoRateLimit = () => SkipThrottle({ default: true, long: true });

export const throttlerOptions = {
  throttlers: [
    { name: 'default', ...rateLimits.publicApi.default },
    { name: 'long', ...rateLimits.publicApi.long },
  ],
  errorMessage: 'Demasiadas solicitudes seguidas. Espera un momento e inténtalo de nuevo.',
};

/** Igual que el guard de Nest, pero con la IP real (Cloudflare → Caddy) y 429 registrados. */
@Injectable()
export class ClientIpThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    return clientIp(req as Request);
  }
  protected async throwThrottlingException(
    context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    const req = context.switchToHttp().getRequest<Request>();
    logEvent(
      'security.rate_limited',
      {
        path: req.route?.path ?? req.path,
        method: req.method,
        window: detail.ttl,
        limit: detail.limit,
      },
      'warn',
    );
    return super.throwThrottlingException(context, detail);
  }
}
