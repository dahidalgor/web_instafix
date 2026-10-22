import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BADGE,
  ICON,
  openNotificationTarget,
  payloadFromEvent,
  showStaffNotification,
  type NotificationOptionsLike,
  type WindowClientLike,
} from './handlers';

const ORIGIN = 'https://admin.instafix.ec';
function registration() {
  const shown: { title: string; options: NotificationOptionsLike }[] = [];
  return {
    shown,
    showNotification: async (title: string, options: NotificationOptionsLike) => {
      shown.push({ title, options });
    },
  };
}
function clients(windows: Partial<WindowClientLike>[] = []) {
  const opened: string[] = [];
  const focused: string[] = [];
  const messages: unknown[] = [];
  const list = windows.map((w) => ({
    url: w.url ?? `${ORIGIN}/`,
    focus: async () => focused.push(w.url ?? ''),
    postMessage: (message: unknown) => messages.push(message),
    ...w,
  }));
  return {
    opened,
    focused,
    messages,
    matchAll: async () => list,
    openWindow: async (url: string) => opened.push(url),
  };
}

test('push: muestra título, cuerpo, icono, badge y etiqueta del aviso', async () => {
  const reg = registration();
  const payload = payloadFromEvent(() =>
    JSON.stringify({
      id: 'n-1',
      type: 'APPOINTMENT_REQUESTED',
      title: 'Nueva solicitud de cita',
      body: 'Pedro está solicitando una cita para Jueves 24 de octubre a las 12H00.',
      url: '/#cita=7d4f2a8e-1b2c-4d5e-8f90-123456789abc',
      entityId: '7d4f2a8e-1b2c-4d5e-8f90-123456789abc',
      createdAt: '2026-10-22T10:00:00.000Z',
    }),
  );
  await showStaffNotification(reg, payload);
  assert.equal(reg.shown.length, 1);
  const [{ title, options }] = reg.shown;
  assert.equal(title, 'Nueva solicitud de cita');
  assert.match(options.body, /^Pedro está solicitando una cita para Jueves/);
  assert.equal(options.icon, ICON);
  assert.equal(options.badge, BADGE);
  // La etiqueta es el id: un push repetido sustituye la notificación, no la duplica.
  assert.equal(options.tag, 'n-1');
  assert.equal(options.data.url, '/#cita=7d4f2a8e-1b2c-4d5e-8f90-123456789abc');
});

test('push sin datos, con texto no JSON o que falla al leerse: aviso genérico sin romper', async () => {
  for (const read of [
    null,
    () => '',
    () => 'no es json',
    () => 'null',
    () => '[1,2]',
    () => {
      throw new Error('payload ilegible');
    },
  ]) {
    const reg = registration();
    await showStaffNotification(reg, payloadFromEvent(read));
    assert.equal(reg.shown.length, 1);
    assert.equal(reg.shown[0].title, 'Instafix');
    assert.ok(reg.shown[0].options.body.length > 0);
    assert.equal(reg.shown[0].options.data.url, '/');
    assert.ok(reg.shown[0].options.tag);
  }
});

test('push con campos de tipo incorrecto o demasiado largos: se normalizan', async () => {
  const reg = registration();
  await showStaffNotification(
    reg,
    payloadFromEvent(() =>
      JSON.stringify({ title: 42, body: 'x'.repeat(5000), type: 'HACK', url: { a: 1 } }),
    ),
  );
  const [{ title, options }] = reg.shown;
  assert.equal(title, 'Instafix');
  assert.equal(options.body.length, 300);
  assert.equal(options.data.type, 'APPOINTMENT_REQUESTED');
  assert.equal(options.data.url, '/');
});

test('clic: enfoca la ventana del panel y la lleva a la cita', async () => {
  const c = clients([{ url: `${ORIGIN}/` }]);
  const target = await openNotificationTarget(c, ORIGIN, {
    url: '/#cita=7d4f2a8e-1b2c-4d5e-8f90-123456789abc',
  });
  assert.equal(target, `${ORIGIN}/#cita=7d4f2a8e-1b2c-4d5e-8f90-123456789abc`);
  assert.equal(c.focused.length, 1);
  assert.deepEqual(c.messages, [{ type: 'instafix:navigate', url: target }]);
  assert.equal(c.opened.length, 0);
});

test('clic sin ventana abierta: abre una nueva en una ruta interna', async () => {
  const c = clients();
  const target = await openNotificationTarget(c, ORIGIN, { url: '/#cita=abc' });
  assert.deepEqual(c.opened, [`${ORIGIN}/#cita=abc`]);
  assert.equal(target, `${ORIGIN}/#cita=abc`);
});

test('clic: nunca abre otro dominio ni esquemas peligrosos', async () => {
  for (const url of [
    'https://evil.example/',
    '//evil.example/x',
    'javascript:alert(1)',
    'data:text/html,hola',
    '/\\evil.example',
    42,
    null,
    undefined,
  ]) {
    const c = clients();
    const target = await openNotificationTarget(c, ORIGIN, { url });
    assert.ok(target.startsWith(`${ORIGIN}/`), `${String(url)} → ${target}`);
    assert.equal(new URL(target).origin, ORIGIN);
  }
  // Datos ausentes en la notificación.
  const c = clients();
  assert.equal(await openNotificationTarget(c, ORIGIN, undefined), `${ORIGIN}/`);
});

test('clic: ignora ventanas de otro origen y abre una propia', async () => {
  const c = clients([{ url: 'https://instafix.ec/' }]);
  await openNotificationTarget(c, ORIGIN, { url: '/' });
  assert.equal(c.focused.length, 0);
  assert.deepEqual(c.opened, [`${ORIGIN}/`]);
});
