import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  appointmentIdFromHash,
  appointmentRequestedMessage,
  customerFirstName,
  formatAppointmentMoment,
  safeNotificationUrl,
} from '@instafix/contracts';
import { deviceLabel } from '../notifications/staff/push.controller';
import { createECDH, randomBytes } from 'node:crypto';
import webpush from 'web-push';
import {
  isAllowedPushEndpoint,
  vapidConfig,
  webPushOptions,
} from '../notifications/staff/web-push.channel';

const GYE = 'America/Guayaquil';

test('mensaje de nueva solicitud: nombre, día y hora de Ecuador', () => {
  // Jueves 22 de octubre de 2026, 17:00 UTC = 12H00 en Guayaquil (UTC−5).
  const message = appointmentRequestedMessage({
    contactName: 'Pedro Pérez',
    startsAt: new Date('2026-10-22T17:00:00Z'),
    timeZone: GYE,
  });
  assert.equal(message.title, 'Nueva solicitud de cita');
  assert.equal(
    message.body,
    'Pedro está solicitando una cita para Jueves 22 de octubre a las 12H00.',
  );
});

test('zona horaria: cerca de medianoche UTC el día es el de Ecuador, no el del servidor', () => {
  // Viernes 03:30 UTC = Jueves 22H30 en Ecuador.
  assert.deepEqual(formatAppointmentMoment(new Date('2026-10-23T03:30:00Z'), GYE), {
    day: 'Jueves 22 de octubre',
    time: '22H30',
  });
  // 05:00 UTC = 00H00 (h23: nunca «24H00»).
  assert.deepEqual(formatAppointmentMoment(new Date('2026-10-23T05:00:00Z'), GYE), {
    day: 'Viernes 23 de octubre',
    time: '00H00',
  });
  assert.equal(formatAppointmentMoment(new Date('2026-10-22T14:05:00Z'), GYE).time, '09H05');
});

test('nombre ausente o no válido: texto genérico, sin teléfono ni apellidos', () => {
  for (const name of ['', '   ', null, undefined, '+593991234567', '0991234567', '***']) {
    const { body } = appointmentRequestedMessage({
      contactName: name,
      startsAt: new Date('2026-10-22T17:00:00Z'),
      timeZone: GYE,
    });
    assert.match(body, /^Un cliente está solicitando una cita para /);
    assert.doesNotMatch(body, /\d{7,}/);
  }
  assert.equal(customerFirstName('  María José  López '), 'María');
});

test('enlace interno a la cita y destinos seguros', () => {
  const id = '7d4f2a8e-1b2c-4d5e-8f90-123456789abc';
  assert.equal(appointmentIdFromHash(`#cita=${id}`), id);
  assert.equal(appointmentIdFromHash('#cita=../../x'), null);
  assert.equal(appointmentIdFromHash('#citas'), null);
  const origin = 'https://admin.instafix.ec';
  assert.equal(safeNotificationUrl(`/#cita=${id}`, origin), `${origin}/#cita=${id}`);
  for (const bad of ['https://evil.example', '//evil.example', 'javascript:alert(1)', '', 3])
    assert.equal(safeNotificationUrl(bad, origin), `${origin}/`);
});

test('solo se envía a servicios push conocidos por https (sin SSRF)', () => {
  for (const ok of [
    'https://web.push.apple.com/QWxhZGRpbjpvcGVu',
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://wns2-par02p.notify.windows.com/w/?token=abc',
  ])
    assert.equal(isAllowedPushEndpoint(ok), true, ok);
  for (const bad of [
    'http://web.push.apple.com/x',
    'https://localhost/x',
    'https://127.0.0.1/x',
    'https://169.254.169.254/latest',
    'https://web.push.apple.com.evil.example/x',
    'https://evilpush.apple.com.example/x',
    'https://web.push.apple.com:8443/x',
    'https://u:p@fcm.googleapis.com/x',
    'no es una url',
  ])
    assert.equal(isAllowedPushEndpoint(bad), false, bad);
});

test('VAPID: configuración incompleta o con formato erróneo se detecta', () => {
  const saved = { ...process.env };
  try {
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    delete process.env.VAPID_SUBJECT;
    assert.equal(vapidConfig().configured, false);
    process.env.VAPID_PUBLIC_KEY = 'A'.repeat(87);
    process.env.VAPID_PRIVATE_KEY = 'B'.repeat(43);
    process.env.VAPID_SUBJECT = 'instafix';
    assert.deepEqual(vapidConfig().problems, ['VAPID_SUBJECT']);
    process.env.VAPID_SUBJECT = 'mailto:avisos@instafix.ec';
    assert.equal(vapidConfig().configured, true);
  } finally {
    process.env = saved;
  }
});

test('etiqueta del dispositivo sin datos únicos', () => {
  assert.equal(
    deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Version/17.5 Safari/604.1'),
    'iPhone · Safari',
  );
  assert.equal(
    deviceLabel('Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Mobile'),
    'Android · Chrome',
  );
  assert.equal(deviceLabel(undefined), 'Dispositivo · Navegador');
});

test('petición Web Push real (sin red): cifrado aes128gcm, VAPID, TTL y prioridad', () => {
  const keys = webpush.generateVAPIDKeys();
  const saved = { ...process.env };
  try {
    Object.assign(process.env, {
      VAPID_PUBLIC_KEY: keys.publicKey,
      VAPID_PRIVATE_KEY: keys.privateKey,
      VAPID_SUBJECT: 'mailto:avisos@instafix.ec',
    });
    // Claves de un navegador de prueba (P-256) como las que entrega pushManager.subscribe().
    const browser = createECDH('prime256v1');
    browser.generateKeys();
    const subscription = {
      endpoint: 'https://web.push.apple.com/QWxhZGRpbjpvcGVu',
      keys: {
        p256dh: browser.getPublicKey().toString('base64url'),
        auth: randomBytes(16).toString('base64url'),
      },
    };
    const body = JSON.stringify({ title: 'Nueva solicitud de cita', body: 'Prueba' });
    const request = webpush.generateRequestDetails(
      subscription,
      body,
      webPushOptions(vapidConfig()),
    );
    assert.equal(request.endpoint, subscription.endpoint);
    assert.equal(request.method, 'POST');
    assert.equal(request.headers['Content-Encoding'], 'aes128gcm');
    assert.equal(request.headers.TTL, 86400);
    assert.equal(request.headers.Urgency, 'high');
    assert.match(String(request.headers.Authorization), /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
    assert.ok(String(request.headers.Authorization).includes(keys.publicKey));
    // El cuerpo va cifrado: el texto del aviso no viaja en claro.
    assert.ok(
      !Buffer.from(request.body as Buffer)
        .toString('utf8')
        .includes('Nueva solicitud'),
    );
  } finally {
    process.env = saved;
  }
});
