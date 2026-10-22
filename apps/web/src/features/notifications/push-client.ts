import type { StaffPushStatus } from '@instafix/contracts/src/push';

/**
 * Activación de Web Push en el panel. Las APIs del navegador llegan inyectadas (`PushEnv`) para
 * probar cada caso; en la app se usa `browserEnv()`.
 */
export type PushSubscriptionLike = {
  endpoint: string;
  options?: { applicationServerKey?: ArrayBuffer | null };
  toJSON(): unknown;
  unsubscribe(): Promise<boolean>;
};
export type RegistrationLike = {
  pushManager: {
    getSubscription(): Promise<PushSubscriptionLike | null>;
    subscribe(options: {
      userVisibleOnly: true;
      applicationServerKey: Uint8Array;
    }): Promise<PushSubscriptionLike>;
  };
};
export type PushEnv = {
  isSecureContext: boolean;
  userAgent: string;
  maxTouchPoints: number;
  /** Abierta desde la pantalla de inicio (display: standalone o navigator.standalone). */
  standalone: boolean;
  hasPushManager: boolean;
  notification: {
    permission: NotificationPermission;
    requestPermission(): Promise<NotificationPermission>;
  } | null;
  serviceWorker: {
    register(url: string, options: { scope: string; type?: 'module' }): Promise<unknown>;
    ready: Promise<RegistrationLike>;
    getRegistration(scope?: string): Promise<RegistrationLike | undefined>;
  } | null;
  storage: { getItem(key: string): string | null; setItem(key: string, value: string): void };
  randomId(): string;
  dev: boolean;
  /** Espera máxima de pushManager.subscribe (pruebas). */
  timeoutMs?: number;
};
/** Llamadas a la API del panel (cookie de sesión); sustituibles en pruebas. */
export type PushApi = {
  status(installationId: string): Promise<StaffPushStatus>;
  subscribe(installationId: string, subscription: unknown): Promise<unknown>;
  unsubscribe(installationId: string): Promise<unknown>;
};

export type Support =
  | { kind: 'supported' }
  | { kind: 'insecure' }
  | { kind: 'ios-install' }
  | { kind: 'ios-update' }
  | { kind: 'unsupported' };

export const isIos = (env: Pick<PushEnv, 'userAgent' | 'maxTouchPoints'>) =>
  /iPhone|iPad|iPod/.test(env.userAgent) ||
  // iPadOS se presenta como Mac; se distingue por la pantalla táctil.
  (/Macintosh/.test(env.userAgent) && env.maxTouchPoints > 1);

/** Versión de iOS según el navegador (null si no se puede leer). */
export function iosVersion(userAgent: string) {
  const match = /OS (\d+)[_.](\d+)/.exec(userAgent) || /Version\/(\d+)\.(\d+)/.exec(userAgent);
  return match ? [Number(match[1]), Number(match[2])] : null;
}

/**
 * ¿Puede este dispositivo recibir Web Push? En iOS solo la web app instalada en la pantalla de
 * inicio (iOS/iPadOS 16.4 o posterior) tiene PushManager; en una pestaña de Safari no existe.
 */
export function detectSupport(env: PushEnv): Support {
  if (!env.isSecureContext) return { kind: 'insecure' };
  const complete = Boolean(env.serviceWorker && env.hasPushManager && env.notification);
  if (isIos(env)) {
    const version = iosVersion(env.userAgent);
    if (version && (version[0] < 16 || (version[0] === 16 && version[1] < 4)))
      return { kind: 'ios-update' };
    if (!env.standalone) return { kind: 'ios-install' };
    return complete ? { kind: 'supported' } : { kind: 'ios-update' };
  }
  return complete ? { kind: 'supported' } : { kind: 'unsupported' };
}

const INSTALLATION_KEY = 'instafix:push-installation';
/** Identificador aleatorio de esta instalación (no identifica a la persona). */
export function installationId(env: PushEnv) {
  let id: string | null = null;
  try {
    id = env.storage.getItem(INSTALLATION_KEY);
  } catch {
    id = null;
  }
  if (id && /^[0-9a-f-]{36}$/i.test(id)) return id;
  id = env.randomId();
  try {
    env.storage.setItem(INSTALLATION_KEY, id);
  } catch {
    // Sin almacenamiento se usa un id por visita: el servidor sustituye la suscripción anterior.
  }
  return id;
}

/** Clave VAPID pública (base64url) → bytes para `applicationServerKey`. */
export function vapidKeyBytes(base64url: string) {
  const padded = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
const sameKey = (subscription: PushSubscriptionLike, key: Uint8Array) => {
  const current = subscription.options?.applicationServerKey;
  if (!current) return true; // Navegadores que no la exponen: se asume la misma.
  const bytes = new Uint8Array(current);
  return bytes.length === key.length && bytes.every((value, i) => value === key[i]);
};

const SW_URL = '/sw.js';
async function registration(env: PushEnv) {
  const sw = env.serviceWorker!;
  // En desarrollo Vite sirve el worker como módulo desde el código fuente.
  if (env.dev) await sw.register('/src/sw/sw.ts', { scope: '/', type: 'module' });
  else await sw.register(SW_URL, { scope: '/' });
  return sw.ready;
}

export type EnableResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'unsupported'
        | 'not-configured'
        | 'denied'
        | 'dismissed'
        | 'subscribe-failed'
        | 'server-failed';
      message: string;
    };

/**
 * Activa los avisos en este dispositivo. Debe llamarse desde un clic: el permiso se pide
 * primero (Safari exige el gesto del usuario) y el éxito solo se declara cuando el servidor
 * guardó la suscripción.
 */
export async function enablePush(env: PushEnv, api: PushApi): Promise<EnableResult> {
  if (detectSupport(env).kind !== 'supported')
    return {
      ok: false,
      reason: 'unsupported',
      message: 'Este navegador no admite notificaciones push.',
    };
  const id = installationId(env);
  const permission =
    env.notification!.permission === 'granted'
      ? 'granted'
      : await env.notification!.requestPermission();
  if (permission === 'denied')
    return {
      ok: false,
      reason: 'denied',
      message: 'Las notificaciones están bloqueadas para Instafix en este dispositivo.',
    };
  if (permission !== 'granted')
    return {
      ok: false,
      reason: 'dismissed',
      message: 'No se activaron: cerraste la solicitud de permiso sin aceptar.',
    };
  let status: StaffPushStatus;
  try {
    status = await api.status(id);
  } catch (error) {
    return { ok: false, reason: 'server-failed', message: errorMessage(error) };
  }
  if (!status.configured || !status.publicKey)
    return {
      ok: false,
      reason: 'not-configured',
      message: 'El servidor aún no tiene configuradas las notificaciones (claves VAPID).',
    };
  const key = vapidKeyBytes(status.publicKey);
  let subscription: PushSubscriptionLike;
  try {
    const reg = await registration(env);
    const existing = await reg.pushManager.getSubscription();
    // Se reutiliza la suscripción del navegador: activar dos veces no crea otra.
    if (existing && sameKey(existing, key)) subscription = existing;
    else {
      if (existing) await existing.unsubscribe().catch(() => false);
      // Sin respuesta del servicio push del navegador no se deja el botón esperando.
      subscription = await withTimeout(
        reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }),
        env.timeoutMs ?? 20000,
      );
    }
  } catch {
    return {
      ok: false,
      reason: 'subscribe-failed',
      message:
        'El navegador no pudo crear la suscripción (el servicio de notificaciones no respondió). Inténtalo de nuevo.',
    };
  }
  try {
    await api.subscribe(id, subscription.toJSON());
  } catch (error) {
    return { ok: false, reason: 'server-failed', message: errorMessage(error) };
  }
  return { ok: true };
}

/** Desactiva los avisos de este dispositivo (servidor y navegador). */
export async function disablePush(env: PushEnv, api: PushApi) {
  const id = installationId(env);
  await api.unsubscribe(id);
  const reg = env.serviceWorker ? await env.serviceWorker.getRegistration('/') : undefined;
  const subscription = reg ? await reg.pushManager.getSubscription() : null;
  await subscription?.unsubscribe().catch(() => false);
}

/**
 * Renovación silenciosa al abrir el panel: si el navegador conserva una suscripción con la
 * clave actual, se vuelve a registrar (el servidor la reactiva o actualiza). Nunca pide permiso.
 */
export async function resyncPush(env: PushEnv, api: PushApi) {
  if (detectSupport(env).kind !== 'supported' || env.notification?.permission !== 'granted')
    return false;
  const reg = await env.serviceWorker!.getRegistration('/');
  const subscription = reg ? await reg.pushManager.getSubscription() : null;
  if (!subscription) return false;
  const id = installationId(env);
  const status = await api.status(id);
  if (!status.publicKey || !sameKey(subscription, vapidKeyBytes(status.publicKey))) return false;
  await api.subscribe(id, subscription.toJSON());
  return true;
}

function withTimeout<T>(promise: Promise<T>, ms: number) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

const errorMessage = (error: unknown) =>
  error instanceof Error && error.message
    ? error.message
    : 'No se pudo guardar la suscripción en el servidor.';

/** APIs reales del navegador. */
export function browserEnv(): PushEnv {
  const nav = navigator as Navigator & { standalone?: boolean };
  return {
    isSecureContext: window.isSecureContext,
    userAgent: nav.userAgent,
    maxTouchPoints: nav.maxTouchPoints || 0,
    standalone:
      nav.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches,
    hasPushManager: 'PushManager' in window,
    notification: 'Notification' in window ? Notification : null,
    serviceWorker:
      'serviceWorker' in nav
        ? (nav.serviceWorker as unknown as NonNullable<PushEnv['serviceWorker']>)
        : null,
    storage: localStorage,
    randomId: () => crypto.randomUUID(),
    dev: import.meta.env.DEV,
  };
}
