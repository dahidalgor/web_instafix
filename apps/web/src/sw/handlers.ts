import {
  parseStaffPushPayload,
  safeNotificationUrl,
  type StaffPushPayload,
} from '@instafix/contracts/src/push';

/**
 * Lógica del service worker, sin dependencias del entorno: recibe lo mínimo de la API del
 * navegador para poder probarla en Node. `sw.ts` la conecta con los eventos reales.
 */
export type NotificationOptionsLike = {
  body: string;
  icon: string;
  badge: string;
  tag: string;
  data: { url: string; id: string; type: string; entityId: string | null };
};
export type RegistrationLike = {
  showNotification(title: string, options: NotificationOptionsLike): Promise<void>;
  getNotifications?(filter?: { tag?: string }): Promise<{ close(): void }[]>;
};
export type WindowClientLike = {
  url: string;
  focused?: boolean;
  focus(): Promise<unknown>;
  navigate?(url: string): Promise<unknown>;
  postMessage?(message: unknown): void;
};
export type ClientsLike = {
  matchAll(options: {
    type: 'window';
    includeUncontrolled: boolean;
  }): Promise<readonly WindowClientLike[]>;
  openWindow(url: string): Promise<unknown>;
};

export const ICON = '/images/instafix-logo-192.png';
export const BADGE = '/images/instafix-logo-128.png';

/** Datos del evento push → texto. `readText` puede lanzar (payload ausente o no texto). */
export function payloadFromEvent(readText: (() => string) | null): StaffPushPayload {
  if (!readText) return parseStaffPushPayload(null);
  try {
    return parseStaffPushPayload(readText());
  } catch {
    return parseStaffPushPayload(null);
  }
}

/**
 * Muestra el aviso. La etiqueta es el id del aviso: si el mismo mensaje llega dos veces,
 * el sistema sustituye la notificación en lugar de apilar otra.
 */
export async function showStaffNotification(
  registration: RegistrationLike,
  payload: StaffPushPayload,
) {
  const tag = payload.id || `instafix-${payload.type}-${payload.entityId ?? 'aviso'}`;
  await registration.showNotification(payload.title, {
    body: payload.body,
    icon: ICON,
    badge: BADGE,
    tag,
    data: { url: payload.url, id: payload.id, type: payload.type, entityId: payload.entityId },
  });
}

/**
 * Clic en el aviso: enfoca una ventana del panel y la lleva a la cita, o abre una nueva.
 * El destino siempre es del mismo origen (nunca otro dominio).
 */
export async function openNotificationTarget(clients: ClientsLike, origin: string, data: unknown) {
  const raw = data && typeof data === 'object' ? (data as { url?: unknown }).url : undefined;
  const target = safeNotificationUrl(raw, origin);
  const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });
  const existing = windows.find((client) => client.url.startsWith(origin));
  if (existing) {
    await existing.focus();
    // La app escucha este mensaje y cambia el hash sin recargar; navigate() es la alternativa.
    if (existing.postMessage) existing.postMessage({ type: 'instafix:navigate', url: target });
    else if (existing.navigate) await existing.navigate(target);
    return target;
  }
  await clients.openWindow(target);
  return target;
}
