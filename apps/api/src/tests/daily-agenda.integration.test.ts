import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { dailyAgendaMessage, parseStaffPushPayload } from '@instafix/contracts';
import webpush from 'web-push';
import { db } from '../database/client';
import { deliverNotification } from '../notifications/notification.service';
import { scheduleDailyAgendas } from '../notifications/staff/staff-notifications';
import { endpointHash, setPushSender } from '../notifications/staff/web-push.channel';

const enabled = process.env.INSTAFIX_INTEGRATION === '1';
const vapid = webpush.generateVAPIDKeys();
Object.assign(process.env, {
  VAPID_PUBLIC_KEY: vapid.publicKey,
  VAPID_PRIVATE_KEY: vapid.privateKey,
  VAPID_SUBJECT: 'mailto:avisos@instafix.ec',
});
const sent: { endpoint: string; body: string }[] = [];
setPushSender(async (subscription, body) => {
  sent.push({ endpoint: subscription.endpoint, body });
});

async function technician(name: string, device = true) {
  const user = await db.user.create({
    data: {
      name,
      phone: `+59392${randomInt(1000000, 9999999)}`,
      passwordHash: 'x',
      role: 'TECHNICIAN',
      phoneVerifiedAt: new Date(),
    },
  });
  const endpoint = `https://fcm.googleapis.com/fcm/send/${randomUUID()}`;
  if (device)
    await db.pushSubscription.create({
      data: {
        userId: user.id,
        endpoint,
        endpointHash: endpointHash(endpoint),
        p256dh: Buffer.from(webpush.generateVAPIDKeys().publicKey, 'base64url').toString(
          'base64url',
        ),
        auth: randomBytes(16).toString('base64url'),
        installationId: randomUUID(),
      },
    });
  return { user, endpoint };
}

test('resumen del técnico: hora y nombre, varios casos', () => {
  const at = (h: string) => new Date(`2026-11-20T${h}:00-05:00`);
  const tz = 'America/Guayaquil';
  assert.deepEqual(
    dailyAgendaMessage(
      [
        { contactName: 'Ana Ruiz', startsAt: at('14:30'), timeZone: tz },
        { contactName: 'Saúl Parra', startsAt: at('10:00'), timeZone: tz },
      ],
      'TODAY',
    ),
    { title: '¡Recuerda tus trabajos de hoy!', body: '10H00 Saúl · 14H30 Ana' },
  );
  assert.deepEqual(
    dailyAgendaMessage([{ contactName: '', startsAt: at('09:00'), timeZone: tz }], 'TOMORROW'),
    { title: 'Mañana tienes 1 trabajo', body: '09H00 Cliente' },
  );
  // Muchas visitas: no se pasa del tamaño del aviso y dice cuántas faltan.
  const many = Array.from({ length: 40 }, (_, i) => ({
    contactName: `Maximiliano${i}`,
    startsAt: new Date(at('08:00').getTime() + i * 60000),
    timeZone: tz,
  }));
  const long = dailyAgendaMessage(many, 'TOMORROW');
  assert.equal(long.title, 'Mañana tienes 40 trabajos');
  assert.ok(long.body.length <= 260);
  assert.match(long.body, / y \d+ más$/);
});

test(
  'técnicos: resumen de mañana a las 19H00 y «¡Recuerda tus trabajos de hoy!» a las 08H00',
  { skip: !enabled },
  async (t) => {
    const tech = await technician('Carlos Agenda');
    const other = await technician('Ana Agenda');
    const offline = await technician('Luis Sin Dispositivo', false);
    const ids: string[] = [];
    const users = [tech.user.id, other.user.id, offline.user.id];
    t.after(async () => {
      setPushSender(null);
      await db.notification.deleteMany({ where: { recipient: { in: users } } });
      await db.appointment.deleteMany({ where: { id: { in: ids } } });
      await db.user.deleteMany({ where: { id: { in: users } } });
    });
    // Un día lejano para no cruzarse con otras citas de la base de pruebas.
    const day = new Date(Date.now() + (40 + randomInt(0, 300)) * 86400000)
      .toISOString()
      .slice(0, 10);
    const local = (d: string, h: string) => new Date(`${d}T${h}:00-05:00`);
    const before = new Date(local(day, '12:00').getTime() - 86400000).toISOString().slice(0, 10);
    const visit = async (time: string, name: string, data: Record<string, unknown>) => {
      const startsAt = local(day, time);
      const row = await db.appointment.create({
        data: {
          title: 'Mantenimiento PS5',
          device: 'PS5',
          startsAt,
          endsAt: new Date(startsAt.getTime() + 7200000),
          address: 'Cumbayá',
          technician: '',
          contactName: name,
          contactPhone: `+59399${randomInt(1000000, 9999999)}`,
          status: 'CONFIRMED',
          ...data,
        },
      });
      ids.push(row.id);
      return row;
    };
    await visit('14:30', 'Ana Ruiz', { assignedTechnicianId: tech.user.id });
    await visit('10:00', 'Saúl Parra', { assignedTechnicianId: tech.user.id });
    // No cuentan: cancelada, sin técnico, de otro día, ni técnico sin dispositivo.
    await visit('16:00', 'Pedro Cancelado', {
      assignedTechnicianId: other.user.id,
      status: 'CANCELLED',
    });
    await visit('11:00', 'Sin Técnico', { status: 'PENDING_LOCATION' });
    await visit('12:00', 'Marta Offline', { assignedTechnicianId: offline.user.id });
    const mine = (stage: string) =>
      db.notification.findMany({
        where: { recipient: tech.user.id, kind: 'DAILY_AGENDA', dedupeKey: { contains: stage } },
      });

    // 19H00 del día anterior: resumen de mañana.
    await scheduleDailyAgendas(local(before, '19:00'));
    const [evening] = await mine(`${day}:TOMORROW`);
    assert.equal((evening.data as { title: string }).title, 'Mañana tienes 2 trabajos');
    assert.equal((evening.data as { body: string }).body, '10H00 Saúl · 14H30 Ana');
    assert.equal(
      await db.notification.count({
        where: { recipient: { in: [other.user.id, offline.user.id] }, kind: 'DAILY_AGENDA' },
      }),
      0,
    );
    // El worker lo revisa cada minuto: no se duplica.
    await scheduleDailyAgendas(local(before, '19:30'));
    assert.equal((await mine(`${day}:TOMORROW`)).length, 1);
    assert.equal(await deliverNotification(evening.id), 'SENT');
    const pushed = parseStaffPushPayload(
      JSON.parse(sent.filter((s) => s.endpoint === tech.endpoint).at(-1)!.body),
    );
    assert.equal(pushed.type, 'DAILY_AGENDA');
    assert.equal(pushed.title, 'Mañana tienes 2 trabajos');
    assert.equal(pushed.url, '/');

    // Fuera de las horas del resumen no se crea nada (06H00 ni 12H00).
    await scheduleDailyAgendas(local(day, '06:00'));
    await scheduleDailyAgendas(local(day, '12:00'));
    assert.equal((await mine(`${day}:TODAY`)).length, 0);

    // 08H00 del mismo día: «¡Recuerda tus trabajos de hoy!» con nombre y hora.
    await scheduleDailyAgendas(local(day, '08:00'));
    const [morning] = await mine(`${day}:TODAY`);
    assert.deepEqual(
      {
        title: (morning.data as { title: string }).title,
        body: (morning.data as { body: string }).body,
      },
      { title: '¡Recuerda tus trabajos de hoy!', body: '10H00 Saúl · 14H30 Ana' },
    );

    // Si no se pudo enviar a tiempo (más de 3 h tarde), ya no se envía.
    await db.notification.update({
      where: { id: morning.id },
      data: {
        data: { ...(morning.data as object), scheduledFor: new Date(Date.now() - 4 * 3600000) },
      },
    });
    assert.equal(await deliverNotification(morning.id), 'CANCELLED');
  },
);
