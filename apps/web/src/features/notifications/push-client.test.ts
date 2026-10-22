import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StaffPushStatus } from '@instafix/contracts/src/push';
import {
  detectSupport,
  disablePush,
  enablePush,
  installationId,
  resyncPush,
  vapidKeyBytes,
  type PushApi,
  type PushEnv,
  type PushSubscriptionLike,
} from './push-client';

const IPHONE_17 =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const IPHONE_16_3 =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.3 Mobile/15E148 Safari/604.1';
const CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
// Clave pública VAPID de ejemplo (65 bytes en base64url).
const KEY = Buffer.from(Uint8Array.from({ length: 65 }, (_, i) => (i * 7) % 256)).toString(
  'base64url',
);
const OTHER_KEY = Buffer.from(Uint8Array.from({ length: 65 }, (_, i) => i % 13)).toString(
  'base64url',
);

function subscription(key = KEY): PushSubscriptionLike & { unsubscribed: boolean } {
  const sub = {
    endpoint: 'https://web.push.apple.com/abc',
    options: { applicationServerKey: vapidKeyBytes(key).buffer as ArrayBuffer },
    unsubscribed: false,
    toJSON: () => ({ endpoint: sub.endpoint, keys: { p256dh: 'p', auth: 'a' } }),
    unsubscribe: async () => {
      sub.unsubscribed = true;
      return true;
    },
  };
  return sub;
}

function env(overrides: Partial<PushEnv> = {}, permission: NotificationPermission = 'default') {
  const store = new Map<string, string>();
  const calls = { register: [] as string[], subscribe: 0, requestPermission: 0 };
  let current: ReturnType<typeof subscription> | null = null;
  const registration = {
    pushManager: {
      getSubscription: async () => current,
      subscribe: async () => {
        calls.subscribe++;
        current = subscription();
        return current;
      },
    },
  };
  const notification = {
    permission,
    requestPermission: async () => {
      calls.requestPermission++;
      return notification.permission;
    },
  };
  const value: PushEnv = {
    isSecureContext: true,
    userAgent: IPHONE_17,
    maxTouchPoints: 5,
    standalone: true,
    hasPushManager: true,
    notification,
    serviceWorker: {
      register: async (url: string) => {
        calls.register.push(url);
        return registration;
      },
      ready: Promise.resolve(registration),
      getRegistration: async () => registration,
    },
    storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v) },
    randomId: () => '11111111-2222-4333-8444-555555555555',
    dev: false,
    ...overrides,
  };
  return {
    env: value,
    calls,
    notification,
    get current() {
      return current;
    },
    set current(next) {
      current = next;
    },
  };
}

function api(status: Partial<StaffPushStatus> = {}, failSubscribe = false) {
  const calls = { subscribe: [] as unknown[], unsubscribe: [] as string[] };
  const value: PushApi = {
    status: async () => ({
      configured: true,
      publicKey: KEY,
      device: null,
      activeDevices: 0,
      receivesNotifications: true,
      ...status,
    }),
    subscribe: async (_id, sub) => {
      if (failSubscribe) throw new Error('El servidor rechazó la suscripción.');
      calls.subscribe.push(sub);
      return { ok: true };
    },
    unsubscribe: async (id) => {
      calls.unsubscribe.push(id);
      return { ok: true };
    },
  };
  return { api: value, calls };
}

test('soporte: APIs ausentes, http, iPhone sin instalar, iOS antiguo, iPhone instalado', () => {
  assert.equal(detectSupport(env().env).kind, 'supported');
  assert.equal(detectSupport(env({ isSecureContext: false }).env).kind, 'insecure');
  assert.equal(detectSupport(env({ standalone: false }).env).kind, 'ios-install');
  assert.equal(
    detectSupport(env({ userAgent: IPHONE_16_3, standalone: true }).env).kind,
    'ios-update',
  );
  assert.equal(
    detectSupport(
      env({ userAgent: CHROME_MAC, maxTouchPoints: 0, hasPushManager: false, standalone: false })
        .env,
    ).kind,
    'unsupported',
  );
  assert.equal(
    detectSupport(env({ userAgent: CHROME_MAC, maxTouchPoints: 0, serviceWorker: null }).env).kind,
    'unsupported',
  );
  assert.equal(
    detectSupport(env({ userAgent: CHROME_MAC, maxTouchPoints: 0, notification: null }).env).kind,
    'unsupported',
  );
  assert.equal(
    detectSupport(env({ userAgent: CHROME_MAC, maxTouchPoints: 0, standalone: false }).env).kind,
    'supported',
  );
});

test('activar con permiso concedido: pide permiso, suscribe y registra en el servidor', async () => {
  const e = env();
  e.notification.requestPermission = async () => {
    e.calls.requestPermission++;
    e.notification.permission = 'granted';
    return 'granted';
  };
  const a = api();
  const result = await enablePush(e.env, a.api);
  assert.deepEqual(result, { ok: true });
  assert.equal(e.calls.requestPermission, 1);
  assert.deepEqual(e.calls.register, ['/sw.js']);
  assert.equal(e.calls.subscribe, 1);
  assert.equal(a.calls.subscribe.length, 1);
  // Activar otra vez reutiliza la suscripción del navegador y no vuelve a pedir permiso.
  await enablePush(e.env, a.api);
  assert.equal(e.calls.subscribe, 1);
  assert.equal(e.calls.requestPermission, 1);
  assert.equal(a.calls.subscribe.length, 2);
});

test('activar con permiso denegado: no suscribe ni llama al servidor', async () => {
  const e = env({}, 'default');
  e.notification.requestPermission = async () => 'denied';
  const a = api();
  const result = await enablePush(e.env, a.api);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, 'denied');
  assert.equal(e.calls.subscribe, 0);
  assert.equal(a.calls.subscribe.length, 0);
});

test('activar y cerrar la solicitud sin decidir: estado no activado', async () => {
  const e = env({}, 'default');
  const a = api();
  const result = await enablePush(e.env, a.api);
  assert.equal(!result.ok && result.reason, 'dismissed');
  assert.equal(e.calls.subscribe, 0);
});

test('activar sin APIs o en iPhone sin instalar: no pide permiso', async () => {
  for (const overrides of [{ standalone: false }, { hasPushManager: false }]) {
    const e = env(overrides);
    const result = await enablePush(e.env, api().api);
    assert.equal(!result.ok && result.reason, 'unsupported');
    assert.equal(e.calls.requestPermission, 0);
  }
});

test('servidor sin VAPID o que falla: no se declara éxito', async () => {
  const e = env({}, 'granted');
  const notConfigured = await enablePush(e.env, api({ configured: false, publicKey: null }).api);
  assert.equal(!notConfigured.ok && notConfigured.reason, 'not-configured');
  const failed = await enablePush(e.env, api({}, true).api);
  assert.equal(failed.ok, false);
  assert.equal(!failed.ok && failed.reason, 'server-failed');
  assert.match(!failed.ok ? failed.message : '', /rechazó/);
});

test('el navegador falla al suscribir: error claro', async () => {
  const e = env({}, 'granted');
  const reg = await e.env.serviceWorker!.ready;
  reg.pushManager.subscribe = async () => {
    throw new Error('AbortError');
  };
  const result = await enablePush(e.env, api().api);
  assert.equal(!result.ok && result.reason, 'subscribe-failed');
});

test('clave VAPID cambiada: se sustituye la suscripción antigua', async () => {
  const e = env({}, 'granted');
  const old = subscription(OTHER_KEY);
  e.current = old;
  const result = await enablePush(e.env, api().api);
  assert.equal(result.ok, true);
  assert.equal(old.unsubscribed, true);
  assert.equal(e.calls.subscribe, 1);
});

test('desactivar: borra en el servidor y en el navegador', async () => {
  const e = env({}, 'granted');
  const a = api();
  await enablePush(e.env, a.api);
  const sub = e.current!;
  await disablePush(e.env, a.api);
  assert.deepEqual(a.calls.unsubscribe, ['11111111-2222-4333-8444-555555555555']);
  assert.equal(sub.unsubscribed, true);
});

test('renovación silenciosa: solo con permiso y suscripción existentes, nunca pide permiso', async () => {
  const none = env({}, 'default');
  assert.equal(await resyncPush(none.env, api().api), false);
  assert.equal(none.calls.requestPermission, 0);

  const granted = env({}, 'granted');
  const a = api();
  assert.equal(await resyncPush(granted.env, a.api), false, 'sin suscripción no hace nada');
  granted.current = subscription();
  assert.equal(await resyncPush(granted.env, a.api), true);
  assert.equal(a.calls.subscribe.length, 1);
  // Clave del servidor distinta: no se re-registra (hay que activar de nuevo).
  granted.current = subscription(OTHER_KEY);
  assert.equal(await resyncPush(granted.env, a.api), false);
});

test('identificador de instalación estable y sin almacenamiento disponible', () => {
  const e = env();
  const first = installationId(e.env);
  assert.equal(installationId(e.env), first);
  const broken = env({
    storage: {
      getItem: () => {
        throw new Error('bloqueado');
      },
      setItem: () => {
        throw new Error('bloqueado');
      },
    },
  });
  assert.match(installationId(broken.env), /^[0-9a-f-]{36}$/);
});

test('el servicio push del navegador no responde: falla a tiempo, sin quedarse esperando', async () => {
  const e = env({ timeoutMs: 20 }, 'granted');
  const reg = await e.env.serviceWorker!.ready;
  reg.pushManager.subscribe = () => new Promise(() => {});
  const a = api();
  const result = await enablePush(e.env, a.api);
  assert.equal(!result.ok && result.reason, 'subscribe-failed');
  assert.equal(a.calls.subscribe.length, 0);
});
