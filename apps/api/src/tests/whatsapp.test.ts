import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { verifySignature } from '../integrations/signature';
import { messageContent, reminderTimes } from '../whatsapp/messages';
import { confirmCalBooking } from '../integrations/cal-client';
import { ProviderError } from '../integrations/provider-error';
import { WasapFlowClient } from '../whatsapp/wasapflow.client';
import type { Appointment } from '@prisma/client';

test('webhooks authenticate the exact bytes, not a reserialized body', () => {
  const raw = Buffer.from('{ "ok": true }');
  const hash = createHmac('sha256', 'test-secret').update(raw).digest('hex');
  assert.doesNotThrow(() => verifySignature(raw, hash, 'test-secret'));
  assert.doesNotThrow(() => verifySignature(raw, `sha256=${hash}`, 'test-secret', 'sha256='));
  assert.throws(() => verifySignature(Buffer.from('{"ok":true}'), hash, 'test-secret'));
  assert.throws(() => verifySignature(raw, 'invalid', 'test-secret'));
  assert.throws(() => verifySignature(raw, hash, undefined));
});

test('Bridge rejects credential-bearing onboarding URLs and untrusted API hosts', async (t) => {
  const saved = { ...process.env },
    original = globalThis.fetch;
  t.after(() => {
    process.env = saved;
    globalThis.fetch = original;
  });
  process.env.WASAPFLOW_PARTNER_KEY = 'fixture-key';
  const client = new WasapFlowClient();
  globalThis.fetch = async (url) =>
    Response.json(
      String(url).endsWith('/embedded-signup/config')
        ? { success: true, connection_mode: 'coexistence' }
        : {
            success: true,
            connect_url:
              'https://officialapi.wasapflow.com/bridge/connect?token=temporary&partner_key=fixture-key',
            expires_in: 1800,
          },
    );
  await assert.rejects(client.createConnectSession('fixture-state'));
  process.env.WASAPFLOW_BASE_URL = 'https://untrusted.invalid';
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    throw new Error('Must not request');
  };
  await assert.rejects(client.sendText('123', '593999123456', 'test'));
  assert.equal(requests, 0);
});

test('texts and 08:00 reminders use Ecuador date across UTC month boundaries', () => {
  const startsAt = new Date('2030-02-01T02:00:00Z');
  const times = reminderTimes(startsAt);
  assert.equal(times.sameDay.toISOString(), '2030-01-31T13:00:00.000Z');
  assert.equal(times.dayBefore.toISOString(), '2030-01-30T13:00:00.000Z');
  assert.equal(times.dayStart.toISOString(), '2030-01-31T05:00:00.000Z');
  const appointment = {
    contactName: 'Ana',
    title: 'Mantenimiento PS5',
    startsAt,
    timeZone: 'America/Guayaquil',
  };
  assert.deepEqual(messageContent('INITIAL', appointment).params, [
    'Ana',
    'Mantenimiento PS5',
    '31/01/2030',
    '21:00',
  ]);
  assert.equal(
    messageContent('CONFIRMED', appointment).text,
    'Listo estimado Ana ✅\nEsta agendada su cita, se le enviará un aviso automático para que pueda estar pendiente de la llegada de su técnico asignado ✅',
  );
  assert.match(messageContent('DAY_BEFORE', appointment).text, /mañana a las 21:00$/);
  assert.match(messageContent('SAME_DAY', appointment).text, /comprensión y paciencia 🙌$/);
});

test('provider uses approved templates, handles uncertain sends and safely retries Cal confirmation', async (t) => {
  const saved = { ...process.env };
  const fetchOriginal = globalThis.fetch;
  t.after(() => {
    process.env = saved;
    globalThis.fetch = fetchOriginal;
  });
  Object.assign(process.env, {
    WASAPFLOW_PARTNER_KEY: 'test',
    WHATSAPP_TEMPLATE_INITIAL: 'instafix_solicitar_ubicacion',
    CAL_API_KEY: 'test',
    CAL_API_VERSION: '2026-02-25',
  });
  const appointment = {
    contactName: 'Ana',
    contactPhone: '+593984703819',
    title: 'PS5',
    startsAt: new Date('2030-01-01T15:00:00Z'),
    timeZone: 'America/Guayaquil',
  } as Appointment;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://officialapi.wasapflow.com/bridge/v1/messages/template');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.to, '593984703819');
    assert.equal(new Headers(init?.headers).get('x-partner-key'), 'test');
    assert.equal(new Headers(init?.headers).get('x-waba-id'), '123');
    assert.equal(body.template.language, 'es');
    assert.equal(body.template.components[0].parameters.length, 4);
    return Response.json({ success: true, message_id: 'wamid.test' });
  };
  assert.equal(
    await new WasapFlowClient().sendTemplate(
      '123',
      '593984703819',
      'instafix_solicitar_ubicacion',
      'es',
      messageContent('INITIAL', appointment).params,
    ),
    'wamid.test',
  );
  globalThis.fetch = async () => {
    throw new Error('timeout');
  };
  await assert.rejects(
    new WasapFlowClient().sendTemplate(
      '123',
      '593984703819',
      'instafix_solicitar_ubicacion',
      'es',
      messageContent('INITIAL', appointment).params,
    ),
    (e: unknown) => e instanceof ProviderError && e.disposition === 'REVIEW',
  );
  globalThis.fetch = async () => Response.json({ error: { code: 4 } }, { status: 429 });
  await assert.rejects(
    new WasapFlowClient().sendTemplate(
      '123',
      '593984703819',
      'instafix_solicitar_ubicacion',
      'es',
      messageContent('INITIAL', appointment).params,
    ),
    (e: unknown) => e instanceof ProviderError && e.disposition === 'RETRY',
  );
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
