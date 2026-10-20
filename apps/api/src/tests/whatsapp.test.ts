import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { verifySignature } from '../integrations/signature';
import { messageVariables, reminderTimes, templateFor } from '../whatsapp/messages';
import { confirmCalBooking } from '../integrations/cal-client';

test('webhooks authenticate the exact bytes, not a reserialized body', () => {
  const raw = Buffer.from('{ "ok": true }');
  const hash = createHmac('sha256', 'test-secret').update(raw).digest('hex');
  assert.doesNotThrow(() => verifySignature(raw, hash, 'test-secret'));
  assert.doesNotThrow(() => verifySignature(raw, `sha256=${hash}`, 'test-secret', 'sha256='));
  assert.throws(() => verifySignature(Buffer.from('{"ok":true}'), hash, 'test-secret'));
  assert.throws(() => verifySignature(raw, 'invalid', 'test-secret'));
  assert.throws(() => verifySignature(raw, hash, undefined));
});

test('notices map to Instafix templates; dates and 08:00 reminders use Ecuador time', () => {
  const startsAt = new Date('2030-02-01T02:00:00Z');
  const times = reminderTimes(startsAt);
  assert.equal(times.sameDay.toISOString(), '2030-01-31T13:00:00.000Z');
  assert.equal(times.dayBefore.toISOString(), '2030-01-30T13:00:00.000Z');
  assert.equal(times.dayStart.toISOString(), '2030-01-31T05:00:00.000Z');
  const appointment = {
    contactName: 'Ana María López',
    title: 'Mantenimiento PS5',
    startsAt,
    timeZone: 'America/Guayaquil',
    technician: 'David',
  };
  assert.deepEqual(messageVariables('CONFIRMED', appointment), {
    nombre: 'Ana',
    servicio: 'Mantenimiento PS5',
    fecha: 'jueves 31 de enero',
    hora: '21:00',
    tecnico: 'David',
    cuando: 'jueves 31 de enero',
  });
  assert.equal(messageVariables('DAY_BEFORE', appointment).cuando, 'mañana');
  assert.equal(messageVariables('SAME_DAY', appointment).cuando, 'hoy');
  assert.equal(
    messageVariables('INITIAL', { ...appointment, technician: undefined }).tecnico,
    'tu técnico de Instafix',
  );
  assert.equal(templateFor('INITIAL'), 'appointment_requested');
  assert.equal(templateFor('DAY_BEFORE'), 'appointment_reminder');
  assert.equal(templateFor('SAME_DAY'), 'appointment_reminder');
  assert.equal(templateFor('CANCELLED'), 'appointment_cancelled');
});

test('Cal.com confirmation is retried safely and only once', async (t) => {
  const saved = { ...process.env };
  const fetchOriginal = globalThis.fetch;
  t.after(() => {
    process.env = saved;
    globalThis.fetch = fetchOriginal;
  });
  Object.assign(process.env, { CAL_API_KEY: 'test', CAL_API_VERSION: '2026-02-25' });
  let posts = 0;
  globalThis.fetch = async (_url, init) => {
    if (init?.method === 'POST') {
      posts++;
      return Response.json({ status: 'success' });
    }
    return Response.json({ data: { status: posts ? 'accepted' : 'pending' } });
  };
  await confirmCalBooking('test');
  await confirmCalBooking('test');
  assert.equal(posts, 1);
});
