import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Request } from 'express';
import { parseStaffPushPayload } from '@instafix/contracts';
import webpush, { WebPushError } from 'web-push';
import { newToken, tokenHash } from '../auth/security';
import { BookingController } from '../booking/booking.controller';
import { db } from '../database/client';
import { setEmailProvider } from '../mail/email.service';
import { publishAppointmentEvent } from '../notifications/appointment-events';
import { deliverNotification, NotificationWorker } from '../notifications/notification.service';
import { PushController } from '../notifications/staff/push.controller';
import { endpointHash, setPushSender } from '../notifications/staff/web-push.channel';

const enabled = process.env.INSTAFIX_INTEGRATION === '1';
const vapid = webpush.generateVAPIDKeys();
Object.assign(process.env, {
  CAL_API_KEY: 'test-key',
  CAL_API_VERSION: '2026-02-25',
  CAL_EVENT_TYPE_ID: '424250',
  CAL_ATTENDEE_RELAY_EMAIL: 'reservas@instafix.ec',
  APPOINTMENT_EMAILS_ENABLED: 'false',
  BOOKING_MIN_DAYS_AHEAD: '1',
  VAPID_PUBLIC_KEY: vapid.publicKey,
  VAPID_PRIVATE_KEY: vapid.privateKey,
  VAPID_SUBJECT: 'mailto:avisos@instafix.ec',
});
setEmailProvider({ name: 'TEST', send: async () => ({ messageId: null }) });

// Cal.com simulado: cada reserva devuelve un uid nuevo.
const original = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: RequestInit) => {
  const url = String(input);
  if (!url.startsWith('https://api.cal.com/')) return original(input, init);
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  if (url.endsWith('/bookings') && init?.method === 'POST')
    return Response.json({
      status: 'success',
      data: {
        uid: `push-${randomUUID()}`,
        status: 'pending',
        start: body.start,
        end: new Date(new Date(body.start).getTime() + 3600000).toISOString(),
      },
    });
  if (url.endsWith('/cancel')) return Response.json({ status: 'success', data: {} });
  // Disponibilidad no simulada: la revalidación se omite (igual que en las demás pruebas).
  return Response.json({}, { status: 404 });
}) as typeof fetch;

/** Envíos «a Apple/Google» capturados; nunca salen a la red. */
type Sent = { endpoint: string; body: string };
let sent: Sent[] = [];
let failWith: ((endpoint: string) => number | null) | null = null;
setPushSender(async (subscription, body) => {
  const status = failWith?.(subscription.endpoint) ?? null;
  if (status !== null) {
    if (status === 0) throw new Error('ECONNRESET');
    throw new WebPushError('rechazado', status, {}, '', subscription.endpoint);
  }
  sent.push({ endpoint: subscription.endpoint, body });
});

const cleanupUsers: string[] = [];
test.after(async () => {
  setPushSender(null);
  globalThis.fetch = original;
  await db.notification.deleteMany({ where: { recipient: { in: cleanupUsers } } });
  await db.appointment.deleteMany({ where: { userId: { in: cleanupUsers } } });
  await db.user.deleteMany({ where: { id: { in: cleanupUsers } } });
});

const ip = () => `10.8.${randomInt(0, 255)}.${randomInt(1, 254)}`;
async function person(role: 'CUSTOMER' | 'ADMIN' | 'TECHNICIAN', name = `Prueba ${role}`) {
  const user = await db.user.create({
    data: {
      name,
      phone: `+59397${randomInt(1000000, 9999999)}`,
      passwordHash: 'x',
      role,
      phoneVerifiedAt: new Date(),
    },
  });
  cleanupUsers.push(user.id);
  const token = newToken();
  await db.session.create({
    data: { userId: user.id, tokenHash: tokenHash(token), expiresAt: new Date(Date.now() + 6e5) },
  });
  const req = (headers: Record<string, string> = {}) =>
    ({
      headers: {
        origin: 'http://localhost:5173',
        cookie: `instafix_session=${token}`,
        'user-agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
        ...headers,
      },
      socket: { remoteAddress: ip() },
      path: '/api/v1/staff/push',
    }) as unknown as Request;
  return { user, req };
}
const b64 = (bytes: number) => randomBytes(bytes).toString('base64url');
const subscription = (host = 'web.push.apple.com') => ({
  endpoint: `https://${host}/${b64(40)}`,
  expirationTime: null,
  keys: { p256dh: b64(65), auth: b64(16) },
});
const status = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return 200;
  } catch (e) {
    return (e as { getStatus?: () => number }).getStatus?.() ?? 500;
  }
};
/** Fecha futura a las `hourUtc` UTC (Ecuador es UTC−5 todo el año). */
const future = (days: number, hourUtc: number) => {
  const d = new Date(Date.now() + days * 86400000);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d;
};
const weekdays = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
// Otras pruebas dejan administradores con dispositivos: cada prueba mira solo los suyos.
const pushRows = (appointmentId: string, recipient?: string) =>
  db.notification.findMany({
    where: { appointmentId, channel: 'WEB_PUSH', ...(recipient ? { recipient } : {}) },
  });
async function deliverAll(appointmentId: string, recipient: string) {
  for (const row of await pushRows(appointmentId, recipient)) await deliverNotification(row.id);
}

test(
  'nueva solicitud de cita: un aviso por administrador con dispositivo, mensaje y hora de Ecuador',
  { skip: !enabled },
  async () => {
    const push = new PushController();
    const admin = await person('ADMIN', 'Admin Avisos');
    const adminWithoutDevice = await person('ADMIN', 'Admin Sin Dispositivo');
    const tech = await person('TECHNICIAN', 'Técnico Avisos');
    const client = await person('CUSTOMER', 'Pedro Pérez');
    const installation = randomUUID();
    const device = subscription();
    await push.subscribe({ installationId: installation, subscription: device }, admin.req());
    await push.subscribe(
      { installationId: randomUUID(), subscription: subscription('fcm.googleapis.com') },
      tech.req(),
    );
    const state = await push.status(admin.req(), installation);
    assert.equal(state.configured, true);
    assert.equal(state.publicKey, vapid.publicKey);
    assert.equal(state.device?.active, true);
    assert.equal(state.device?.label, 'iPhone · Safari');
    assert.equal(state.receivesNotifications, true);
    // El estado nunca devuelve el endpoint ni las claves.
    assert.ok(!JSON.stringify(state).includes(device.endpoint));
    assert.ok(!JSON.stringify(state).includes(device.keys.auth));
    assert.equal((await push.status(tech.req(), '')).receivesNotifications, false);

    // 17:00 UTC = 12H00 en Ecuador.
    const start = future(4, 17);
    const booking = new BookingController();
    const key = { 'idempotency-key': `push-${randomUUID()}` };
    const created = await booking.create(
      { start: start.toISOString(), request: 'Mantenimiento de laptop', whatsappConsent: false },
      client.req(key),
    );
    // Reintento de la misma operación (doble clic, recarga): misma respuesta, sin otro aviso.
    const again = await booking.create(
      { start: start.toISOString(), request: 'Mantenimiento de laptop', whatsappConsent: false },
      client.req(key),
    );
    assert.equal(again.appointmentId, created.appointmentId);
    // Mismo hecho publicado otra vez (p. ej. webhook de Cal.com tras la respuesta de la API).
    const stored = await db.appointment.findUniqueOrThrow({
      where: { id: created.appointmentId },
    });
    await db.$transaction((tx) =>
      publishAppointmentEvent(tx, stored, { type: 'appointment.created' }),
    );

    const recipients = (await pushRows(created.appointmentId)).map((r) => r.recipient);
    // Solo administradores con dispositivo: ni el técnico ni el administrador sin dispositivo.
    assert.ok(!recipients.includes(tech.user.id));
    assert.ok(!recipients.includes(adminWithoutDevice.user.id));
    // Un único aviso para este administrador pese al reintento y al evento repetido.
    const rows = await pushRows(created.appointmentId, admin.user.id);
    assert.equal(rows.length, 1);
    const [row] = rows;
    assert.equal(row.kind, 'APPOINTMENT_REQUESTED');
    assert.equal(row.status, 'PENDING');
    const expectedDay = weekdays[new Date(start.getTime() - 5 * 3600000).getUTCDay()];
    const data = row.data as { title: string; body: string; url: string };
    assert.equal(data.title, 'Nueva solicitud de cita');
    assert.match(
      data.body,
      new RegExp(
        `^Pedro está solicitando una cita para ${expectedDay} \\d+ de \\S+ a las 12H00\\.$`,
      ),
    );
    assert.equal(data.url, `/#cita=${created.appointmentId}`);
    // Sin teléfono ni apellido del cliente en el aviso.
    assert.ok(!JSON.stringify(row.data).includes(client.user.phone));
    assert.ok(!JSON.stringify(row.data).includes('Pérez'));

    sent = [];
    assert.equal(await deliverNotification(row.id), 'SENT');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].endpoint, device.endpoint);
    const payload = parseStaffPushPayload(sent[0].body);
    assert.equal(payload.title, 'Nueva solicitud de cita');
    assert.equal(payload.entityId, created.appointmentId);
    assert.equal(payload.id, row.id);
    // Entregado: no se vuelve a enviar.
    assert.equal(await deliverNotification(row.id), 'SKIPPED');
    assert.equal(sent.length, 1);
    const after = await push.status(admin.req(), installation);
    assert.ok(after.device?.lastSuccessAt);
  },
);

test(
  'un fallo de Web Push no deshace la cita; 410 desactiva el dispositivo; los demás reciben',
  { skip: !enabled },
  async () => {
    const push = new PushController();
    const admin = await person('ADMIN');
    const client = await person('CUSTOMER', 'Ana');
    const iphone = subscription();
    const laptop = subscription('fcm.googleapis.com');
    await push.subscribe({ installationId: randomUUID(), subscription: iphone }, admin.req());
    await push.subscribe({ installationId: randomUUID(), subscription: laptop }, admin.req());

    // El servicio push está caído en todos los dispositivos: la reserva funciona igual.
    failWith = () => 0;
    const created = await new BookingController().create(
      { start: future(5, 15).toISOString(), request: 'Revisión', whatsappConsent: false },
      client.req(),
    );
    assert.ok(
      await db.appointment.findUnique({ where: { id: created.appointmentId } }),
      'la cita existe',
    );
    const [row] = await pushRows(created.appointmentId, admin.user.id);
    assert.equal(await deliverNotification(row.id), 'RETRY');
    const retry = await db.notification.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(retry.status, 'RETRY');
    assert.doesNotMatch(retry.lastError ?? '', /https?:\/\//, 'sin endpoint en el error');

    // Un dispositivo caducado (410) y otro que funciona: se entrega y el caducado se desactiva.
    failWith = (endpoint) => (endpoint === iphone.endpoint ? 410 : null);
    sent = [];
    await db.notification.update({ where: { id: row.id }, data: { dueAt: new Date() } });
    assert.equal(await deliverNotification(row.id), 'SENT');
    assert.deepEqual(
      sent.map((s) => s.endpoint),
      [laptop.endpoint],
    );
    const gone = await db.pushSubscription.findUniqueOrThrow({
      where: { endpointHash: endpointHash(iphone.endpoint) },
    });
    assert.equal(gone.active, false);
    assert.match(gone.failureReason ?? '', /caducada/);

    // Si todos caducan, el aviso queda suprimido (sin reintentos) y la cita sigue intacta.
    failWith = () => 404;
    const second = await new BookingController().create(
      { start: future(6, 15).toISOString(), request: 'Otra', whatsappConsent: false },
      client.req(),
    );
    const [secondRow] = await pushRows(second.appointmentId, admin.user.id);
    assert.equal(await deliverNotification(secondRow.id), 'SKIPPED');
    assert.equal(
      (await db.notification.findUniqueOrThrow({ where: { id: secondRow.id } })).status,
      'SUPPRESSED',
    );
    assert.equal(
      await db.pushSubscription.count({ where: { userId: admin.user.id, active: true } }),
      0,
    );
    failWith = null;
  },
);

test(
  'cita cancelada o destinatario sin permiso antes del envío: no se envía',
  { skip: !enabled },
  async () => {
    const push = new PushController();
    const admin = await person('ADMIN');
    const client = await person('CUSTOMER', 'Luis');
    await push.subscribe(
      { installationId: randomUUID(), subscription: subscription() },
      admin.req(),
    );
    const booking = new BookingController();
    const one = await booking.create(
      { start: future(7, 16).toISOString(), request: 'Uno', whatsappConsent: false },
      client.req(),
    );
    await booking.cancel(one.appointmentId, client.req());
    sent = [];
    await deliverAll(one.appointmentId, admin.user.id);
    assert.equal(sent.length, 0);
    const [cancelled] = await pushRows(one.appointmentId, admin.user.id);
    assert.equal(cancelled.status, 'CANCELLED');

    const two = await booking.create(
      { start: future(8, 16).toISOString(), request: 'Dos', whatsappConsent: false },
      client.req(),
    );
    await db.user.update({ where: { id: admin.user.id }, data: { role: 'TECHNICIAN' } });
    await deliverAll(two.appointmentId, admin.user.id);
    assert.equal(sent.length, 0);
    const [demoted] = await pushRows(two.appointmentId, admin.user.id);
    assert.equal(demoted.status, 'CANCELLED');
  },
);

test(
  'suscripciones: solo el equipo, siempre las propias, datos validados',
  { skip: !enabled },
  async () => {
    const push = new PushController();
    const adminA = await person('ADMIN');
    const adminB = await person('ADMIN');
    const client = await person('CUSTOMER');
    const installation = randomUUID();
    const body = { installationId: installation, subscription: subscription() };

    // Clientes: nada de avisos del equipo.
    assert.equal(await status(push.status(client.req(), installation)), 403);
    assert.equal(await status(push.subscribe(body, client.req())), 403);
    assert.equal(
      await status(push.unsubscribe({ installationId: installation }, client.req())),
      403,
    );
    assert.equal(await status(push.test(client.req())), 403);
    // Sin sesión.
    const anonymous = {
      headers: { origin: 'http://localhost:5173' },
      socket: { remoteAddress: ip() },
      path: '/x',
    } as unknown as Request;
    assert.equal(await status(push.status(anonymous, installation)), 401);
    // Otro origen (CSRF).
    assert.equal(
      await status(push.subscribe(body, adminA.req({ origin: 'https://evil.example' }))),
      403,
    );

    // Validación: solo servicios push reales por https; claves con formato correcto.
    for (const endpoint of [
      'http://web.push.apple.com/x',
      'https://169.254.169.254/latest/meta-data',
      'https://evil.example/web.push.apple.com',
      'https://web.push.apple.com.evil.example/x',
      'https://user:pass@web.push.apple.com/x',
    ])
      assert.equal(
        await status(
          push.subscribe(
            { installationId: installation, subscription: { ...body.subscription, endpoint } },
            adminA.req(),
          ),
        ),
        400,
        endpoint,
      );
    assert.equal(
      await status(
        push.subscribe(
          {
            installationId: installation,
            subscription: { ...body.subscription, keys: { p256dh: 'x', auth: 'y' } },
          },
          adminA.req(),
        ),
      ),
      400,
    );
    assert.equal(
      await status(push.subscribe({ ...body, userId: adminB.user.id }, adminA.req())),
      400,
      'no se acepta un id de usuario del cliente',
    );
    assert.equal(
      await status(push.subscribe({ ...body, installationId: 'no-uuid' }, adminA.req())),
      400,
    );

    // Activar dos veces el mismo dispositivo no crea duplicados.
    await push.subscribe(body, adminA.req());
    await push.subscribe(body, adminA.req());
    assert.equal(await db.pushSubscription.count({ where: { userId: adminA.user.id } }), 1);
    // Mismo navegador con una suscripción nueva: la anterior se desactiva.
    await push.subscribe(
      { installationId: installation, subscription: subscription() },
      adminA.req(),
    );
    assert.equal(
      await db.pushSubscription.count({ where: { userId: adminA.user.id, active: true } }),
      1,
    );

    // B no puede ver ni desactivar los dispositivos de A aunque conozca su installationId.
    const seenByB = await push.status(adminB.req(), installation);
    assert.equal(seenByB.device, null);
    assert.equal(seenByB.activeDevices, 0);
    const removedByB = await push.unsubscribe({ installationId: installation }, adminB.req());
    assert.equal(removedByB.devices, 0);
    assert.equal(
      await db.pushSubscription.count({ where: { userId: adminA.user.id, active: true } }),
      1,
    );
    // A sí desactiva el suyo.
    assert.equal(
      (await push.unsubscribe({ installationId: installation }, adminA.req())).devices,
      1,
    );
    assert.equal((await push.status(adminA.req(), installation)).device?.active, false);

    // Sin claves VAPID: el registro responde 503 y el estado lo indica; nada se rompe.
    const saved = process.env.VAPID_PRIVATE_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    try {
      assert.equal(await status(push.subscribe(body, adminA.req())), 503);
      const off = await push.status(adminA.req(), installation);
      assert.equal(off.configured, false);
      assert.equal(off.publicKey, null);
    } finally {
      process.env.VAPID_PRIVATE_KEY = saved;
    }
  },
);

test(
  'el worker entrega los avisos push pendientes y respeta la configuración',
  { skip: !enabled },
  async () => {
    const push = new PushController();
    const admin = await person('ADMIN');
    const client = await person('CUSTOMER', 'Marta');
    await push.subscribe(
      { installationId: randomUUID(), subscription: subscription() },
      admin.req(),
    );
    const created = await new BookingController().create(
      { start: future(9, 14).toISOString(), request: 'Worker', whatsappConsent: false },
      client.req(),
    );
    // Sin VAPID el worker no toca los avisos push: esperan en la bandeja.
    const saved = process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PUBLIC_KEY;
    try {
      await new NotificationWorker().tick();
      assert.equal((await pushRows(created.appointmentId, admin.user.id))[0].status, 'PENDING');
    } finally {
      process.env.VAPID_PUBLIC_KEY = saved;
    }
    sent = [];
    await new NotificationWorker().tick();
    assert.equal((await pushRows(created.appointmentId, admin.user.id))[0].status, 'SENT');
    assert.ok(sent.some((s) => parseStaffPushPayload(s.body).entityId === created.appointmentId));
  },
);
