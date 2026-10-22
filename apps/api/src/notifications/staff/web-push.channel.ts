import type { StaffPushPayload } from '@instafix/contracts';
import { createHash } from 'node:crypto';
import webpush, { WebPushError } from 'web-push';
import { logEvent } from '../../common/log-event';
import { db } from '../../database/client';
import type { ChannelOutcome, StaffChannel } from './channels';

/**
 * Claves VAPID (solo backend). La pública se entrega al panel para suscribirse; la privada
 * nunca sale del servidor ni se registra. Generarlas: `pnpm --filter @instafix/api push:keys`.
 */
export function vapidConfig() {
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim() || '';
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim() || '';
  const subject = process.env.VAPID_SUBJECT?.trim() || '';
  const problems: string[] = [];
  if (!/^[A-Za-z0-9_-]{87}$/.test(publicKey)) problems.push('VAPID_PUBLIC_KEY');
  if (!/^[A-Za-z0-9_-]{43}$/.test(privateKey)) problems.push('VAPID_PRIVATE_KEY');
  // Apple exige un sujeto válido (mailto: o https:) o rechaza el envío con 403.
  if (!/^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/.test(subject)) problems.push('VAPID_SUBJECT');
  return { publicKey, privateKey, subject, configured: problems.length === 0, problems };
}

/** Opciones de envío (VAPID, caducidad y prioridad). */
export function webPushOptions(config: ReturnType<typeof vapidConfig>) {
  return {
    vapidDetails: {
      subject: config.subject,
      publicKey: config.publicKey,
      privateKey: config.privateKey,
    },
    // Un aviso de cita que llega un día tarde ya no sirve.
    TTL: 86400,
    // Alta prioridad: el sistema lo muestra aunque el dispositivo esté en reposo.
    urgency: 'high' as const,
  };
}

/** Servicios push de los navegadores. El servidor solo envía a estos dominios (evita SSRF). */
const pushHosts = [
  'push.apple.com', // Safari / iOS (web.push.apple.com)
  'fcm.googleapis.com', // Chrome, Edge (Android y escritorio)
  'push.services.mozilla.com', // Firefox
  'notify.windows.com', // Edge antiguo (WNS)
];
export function isAllowedPushEndpoint(endpoint: string) {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
    return pushHosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}
export const endpointHash = (endpoint: string) =>
  createHash('sha256').update(endpoint).digest('hex');

/** Código del proveedor → la suscripción ya no sirve y se desactiva. */
const goneStatuses = new Set([404, 410]);
/** VAPID rechazado (p. ej. claves cambiadas): hay que volver a activar en el dispositivo. */
const rejectedStatuses = new Set([401, 403]);

/** Envío real, sustituible en pruebas (nunca se llama a Apple/Google desde los tests). */
export type PushSender = (
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  body: string,
) => Promise<unknown>;
let sender: PushSender | null = null;
export function setPushSender(next: PushSender | null) {
  sender = next;
}

export class WebPushChannel implements StaffChannel {
  readonly name = 'WEB_PUSH' as const;
  configured() {
    return vapidConfig().configured;
  }

  async deliver(userId: string, payload: StaffPushPayload): Promise<ChannelOutcome> {
    const config = vapidConfig();
    if (!config.configured) return { status: 'RETRY', reason: 'Web Push sin configurar' };
    const devices = await db.pushSubscription.findMany({ where: { userId, active: true } });
    if (!devices.length) return { status: 'NO_DEVICES', reason: 'Sin dispositivos activos' };
    const body = JSON.stringify(payload);
    const send: PushSender =
      sender ??
      ((subscription, data) =>
        webpush.sendNotification(subscription, data, webPushOptions(config)));
    let delivered = 0;
    let retryable = 0;
    let permanent = 0;
    let lastReason = '';
    for (const device of devices) {
      // Defensa adicional: una fila antigua o manipulada nunca dirige el envío a otro host.
      if (!isAllowedPushEndpoint(device.endpoint)) {
        await this.deactivate(device.id, 'Endpoint no permitido');
        continue;
      }
      try {
        await send(
          { endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } },
          body,
        );
        delivered++;
        await db.pushSubscription.update({
          where: { id: device.id },
          data: { lastSuccessAt: new Date(), failureReason: null },
        });
      } catch (error) {
        const status = error instanceof WebPushError ? error.statusCode : 0;
        // Solo el código HTTP: el cuerpo del proveedor puede repetir el endpoint.
        lastReason = status
          ? `El servicio push respondió ${status}`
          : 'Servicio push no disponible';
        if (goneStatuses.has(status)) {
          await this.deactivate(device.id, 'Suscripción caducada o revocada');
        } else if (rejectedStatuses.has(status)) {
          await this.deactivate(device.id, 'Clave VAPID rechazada; vuelve a activar el aviso');
        } else if (status === 400 || status === 413) {
          permanent++;
          await this.fail(device.id, lastReason);
        } else {
          retryable++;
          await this.fail(device.id, lastReason);
        }
        logEvent('push.delivery_failed', { status, type: payload.type }, 'warn');
      }
    }
    if (delivered) return { status: 'SENT', delivered, failed: retryable + permanent };
    if (retryable) return { status: 'RETRY', reason: lastReason };
    if (permanent) return { status: 'FAILED', reason: lastReason };
    return { status: 'NO_DEVICES', reason: 'Las suscripciones del usuario caducaron' };
  }

  private deactivate(id: string, reason: string) {
    return db.pushSubscription.update({
      where: { id },
      data: { active: false, lastFailureAt: new Date(), failureReason: reason },
    });
  }
  private fail(id: string, reason: string) {
    return db.pushSubscription.update({
      where: { id },
      data: { lastFailureAt: new Date(), failureReason: reason },
    });
  }
}
