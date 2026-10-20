import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import {
  BirdAuthError,
  BirdConnectionError,
  BirdRateLimitError,
  BirdTimeoutError,
  BirdValidationError,
  type BirdClient,
} from '@messagebird/sdk';
import { setBirdClient } from '../whatsapp/bird/bird.client';
import { BirdWhatsAppProvider } from '../whatsapp/bird/bird.provider';
import { WebhookSignatureError, WhatsAppProviderError } from '../whatsapp/provider';
import { signedWebhook, webhookSecret } from './support/bird-webhooks';

// Ningún test toca la red: el cliente de Bird es un doble con la misma forma que el SDK.
const env = {
  BIRD_API_KEY: 'bk_us1_test_fixture',
  WHATSAPP_BUSINESS_PHONE: '+593984703819',
};
const bodies: Record<string, string> = {
  appointment_confirmed:
    'Tu visita del {{fecha}} a las {{hora}} está confirmada. Te atenderá {{tecnico}}.',
  appointment_requested: 'Hola {{nombre}}, envíanos tu ubicación para {{servicio}}.',
  appointment_reminder: 'Hola {{1}}, tu visita es {{2}}.',
};
function fakeBird(overrides: { send?: (params: any) => Promise<any> } = {}) {
  const sends: any[] = [];
  const templateGets: string[] = [];
  const client = {
    whatsapp: {
      send: async (params: any) => {
        sends.push(params);
        if (overrides.send) return overrides.send(params);
        return { id: `wam_${sends.length}`, status: 'accepted' };
      },
      templates: {
        get: async (slug: string) => {
          templateGets.push(slug);
          return {
            slug,
            status: bodies[slug] || slug === 'bird_otp' ? 'active' : 'rejected',
            default_language: slug === 'appointment_requested' ? 'es' : 'es-EC',
            live_version_id: bodies[slug] ? 'wtv_1' : null,
          };
        },
        versions: {
          languages: {
            get: async (slug: string) => ({
              components: [{ type: 'BODY', text: bodies[slug] }, { type: 'FOOTER' }],
            }),
          },
        },
      },
      numbers: {
        list: async function* () {
          yield {
            scope: 'system',
            phone_number: '+18555550100',
            status: 'connected',
          };
          yield {
            scope: 'workspace',
            phone_number: '+593984703819',
            status: 'connected',
            is_on_business_app: true,
            quality_rating: 'unknown',
            messaging_limit: 'tier_250',
          };
        },
      },
    },
  };
  setBirdClient(client as unknown as BirdClient);
  return { sends, templateGets };
}
const apiError = (Kind: any, statusCode: number, extra: Record<string, unknown> = {}) =>
  new Kind({
    statusCode,
    code: 'E00001',
    type: 'error',
    errorName: 'x',
    message: 'Fixture error',
    docUrl: '',
    requestId: 'req_fixture',
    ...extra,
  });

test('Bird templates: named variables, real language, sender number; no Bird payload outside the provider', async (t) => {
  const saved = { ...process.env };
  t.after(() => {
    process.env = saved;
    setBirdClient(null);
  });
  Object.assign(process.env, env);
  const { sends, templateGets } = fakeBird();
  const provider = new BirdWhatsAppProvider();
  const sent = await provider.sendTemplate({
    to: '+593998686244',
    template: 'appointment_confirmed',
    variables: { nombre: 'Ana', fecha: 'viernes 24 de octubre', hora: '10:00', tecnico: 'David' },
  });
  assert.deepEqual(sends[0], {
    to: '+593998686244',
    from: '+593984703819',
    template: {
      slug: 'appointment_confirmed',
      language: 'es-EC',
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', name: 'fecha', text: 'viernes 24 de octubre' },
            { type: 'text', name: 'hora', text: '10:00' },
            { type: 'text', name: 'tecnico', text: 'David' },
          ],
        },
      ],
    },
  });
  assert.deepEqual(sent, {
    providerMessageId: 'wam_1',
    accountId: '+593984703819',
    text: 'Tu visita del viernes 24 de octubre a las 10:00 está confirmada. Te atenderá David.',
  });
  // Cada plantilla con su propio idioma aprobado.
  await provider.sendTemplate({
    to: '+593998686244',
    template: 'appointment_requested',
    variables: { nombre: 'Ana', servicio: 'PS5' },
  });
  assert.equal(sends[1].template.language, 'es');
  // El catálogo se cachea: un segundo envío no vuelve a consultar la plantilla.
  await provider.sendTemplate({
    to: '+593998686244',
    template: 'appointment_confirmed',
    variables: { fecha: 'x', hora: 'y', tecnico: 'z' },
  });
  assert.equal(templateGets.filter((s) => s === 'appointment_confirmed').length, 1);

  // Variables posicionales o que Instafix no ofrece: no se envía nada.
  await assert.rejects(
    provider.sendTemplate({
      to: '+593998686244',
      template: 'appointment_reminder',
      variables: { nombre: 'Ana' },
    }),
    (e: unknown) => e instanceof WhatsAppProviderError && e.code === 'TEMPLATE',
  );
  // Plantilla no aprobada.
  await assert.rejects(
    provider.sendTemplate({
      to: '+593998686244',
      template: 'appointment_cancelled',
      variables: {},
    }),
    (e: unknown) =>
      e instanceof WhatsAppProviderError &&
      e.code === 'TEMPLATE_NOT_APPROVED' &&
      e.disposition === 'FAILED',
  );
  assert.equal(sends.length, 3);
});

test('OTP uses the Bird-managed authentication template with the copy-code button', async (t) => {
  const saved = { ...process.env };
  t.after(() => {
    process.env = saved;
    setBirdClient(null);
  });
  Object.assign(process.env, env);
  const { sends } = fakeBird();
  const sent = await new BirdWhatsAppProvider().sendAuthenticationCode({
    to: '+593998686244',
    code: '482913',
  });
  assert.deepEqual(sends[0], {
    to: '+593998686244',
    template: {
      slug: 'bird_otp',
      language: 'es',
      components: [
        { type: 'body', parameters: [{ type: 'text', text: '482913' }] },
        { type: 'button', parameters: [{ type: 'text', text: '482913' }] },
      ],
    },
  });
  // Sin «from»: la plantilla gestionada sale desde el número de Bird. El código no se guarda.
  assert.equal('from' in sends[0], false);
  assert.equal(sent.text, null);
});

test('Bird errors are normalized and never leak the key or the full phone', async (t) => {
  const saved = { ...process.env };
  t.after(() => {
    process.env = saved;
    setBirdClient(null);
  });
  Object.assign(process.env, env);
  const provider = new BirdWhatsAppProvider();
  const cases: [unknown, string, string][] = [
    [apiError(BirdAuthError, 401), 'AUTH', 'FAILED'],
    [apiError(BirdRateLimitError, 429), 'RATE_LIMIT', 'RETRY'],
    [apiError(BirdValidationError, 422, { param: 'to' }), 'RECIPIENT', 'FAILED'],
    [new BirdConnectionError('down'), 'NETWORK', 'RETRY'],
    // Bird pudo haber aceptado el mensaje: revisar, no reenviar.
    [new BirdTimeoutError('slow', 15000), 'NETWORK', 'REVIEW'],
  ];
  for (const [error, code, disposition] of cases) {
    fakeBird({
      send: async () => {
        throw error;
      },
    });
    await assert.rejects(
      provider.sendAuthenticationCode({ to: '+593998686244', code: '111111' }),
      (e: unknown) => {
        assert.ok(e instanceof WhatsAppProviderError);
        assert.equal(e.code, code);
        assert.equal(e.disposition, disposition);
        assert.equal(e.message.includes('bk_us1_test_fixture'), false);
        assert.equal(e.message.includes('593998686244'), false);
        assert.equal(e.message.includes('111111'), false);
        return true;
      },
    );
  }
  delete process.env.BIRD_API_KEY;
  setBirdClient(null);
  await assert.rejects(
    provider.sendAuthenticationCode({ to: '+593998686244', code: '111111' }),
    (e: unknown) => e instanceof WhatsAppProviderError && e.code === 'CONFIG',
  );
});

test('account status reports the Instafix number, Coexistence and template problems', async (t) => {
  const saved = { ...process.env };
  t.after(() => {
    process.env = saved;
    setBirdClient(null);
  });
  Object.assign(process.env, env);
  fakeBird();
  const status = await new BirdWhatsAppProvider().accountStatus();
  assert.deepEqual(status.number, {
    phone: '+593984703819',
    status: 'connected',
    coexistence: true,
    quality: 'unknown',
    messagingLimit: 'tier_250',
  });
  const byName = Object.fromEntries(status.templates.map((tpl) => [tpl.name, tpl]));
  assert.equal(byName.appointment_confirmed.status, 'active');
  assert.equal(byName.appointment_confirmed.problem, null);
  assert.match(byName.appointment_reminder.problem!, /1, 2/);
  assert.equal(byName.appointment_cancelled.status, 'pending');
  assert.deepEqual(status.authenticationTemplate, { name: 'bird_otp', status: 'active' });
});

const base = (type: string, data: Record<string, unknown>) => ({
  type,
  timestamp: '2026-10-20T19:17:05.000Z',
  data: {
    whatsapp_id: 'wam_out_1',
    workspace_id: 'ws_1',
    direction: 'outbound',
    from: { phone_number: '+593984703819' },
    to: { phone_number: '+593998686244' },
    tags: null,
    metadata: null,
    ...data,
  },
});

test('Bird webhooks: signature on raw bytes, normalized statuses and inbound sources', (t) => {
  const saved = { ...process.env };
  t.after(() => {
    process.env = saved;
  });
  process.env.BIRD_WEBHOOK_SECRET = webhookSecret;
  const provider = new BirdWhatsAppProvider();
  const parse = (body: unknown) => {
    const { raw, headers } = signedWebhook(webhookSecret, body, 'msg_fixed');
    return provider.parseWebhook(raw, headers);
  };
  assert.deepEqual(parse(base('whatsapp.delivered', {})), {
    kind: 'STATUS',
    eventId: 'msg_fixed',
    providerMessageId: 'wam_out_1',
    status: 'DELIVERED',
    occurredAt: new Date('2026-10-20T19:17:05.000Z'),
  });
  assert.equal((parse(base('whatsapp.read', {})) as any).status, 'READ');
  assert.equal((parse(base('whatsapp.sent', {})) as any).status, 'SENT');
  assert.deepEqual(
    (
      parse(
        base('whatsapp.failed', {
          error: { code: 'undeliverable', description: 'x', meta_error_code: '131026' },
        }),
      ) as any
    ).error,
    { code: 'undeliverable', metaCode: '131026' },
  );
  assert.equal(
    (parse(base('whatsapp.rejected', { error: { code: 'x' } })) as any).status,
    'FAILED',
  );
  // «Aceptado» no es un estado de entrega.
  assert.equal(parse(base('whatsapp.accepted', {})).kind, 'IGNORED');

  const inbound = (extra: Record<string, unknown>) =>
    parse(
      base('whatsapp.received', {
        whatsapp_id: 'wam_in_1',
        direction: 'inbound',
        from: { phone_number: '+593998686244', bsuid: 'EC.123' },
        to: { phone_number: '+593984703819' },
        ...extra,
      }),
    ) as any;
  const location = inbound({
    location: { latitude: -0.18, longitude: -78.48, address: 'Av. Amazonas' },
    in_reply_to_message_id: 'wam_out_1',
  });
  assert.equal(location.kind, 'MESSAGE');
  assert.equal(location.source, 'customer_live');
  assert.equal(location.phone, '+593998686244');
  assert.equal(location.accountId, '+593984703819');
  assert.equal(location.inReplyTo, 'wam_out_1');
  assert.deepEqual(location.location, {
    latitude: -0.18,
    longitude: -78.48,
    address: 'Av. Amazonas',
  });
  const media = inbound({ image: { id: 'f1', mime_type: 'image/jpeg', caption: 'Mi consola' } });
  assert.deepEqual(media.media, { type: 'image', mimeType: 'image/jpeg', caption: 'Mi consola' });
  assert.equal(media.text, 'Mi consola');
  assert.equal(inbound({ text: { body: 'Hola' } }).text, 'Hola');
  // Ecos de la app Business e historial (Coexistence) nunca cuentan como mensaje del cliente.
  assert.equal(inbound({ origin: 'history_sync', text: { body: 'viejo' } }).source, 'history');
  const echo = parse(
    base('whatsapp.received', { origin: 'business_app_echo', text: { body: 'Te escribo' } }),
  ) as any;
  assert.equal(echo.source, 'business_app');
  assert.equal(echo.phone, '+593998686244');

  // Firma inválida, cuerpo alterado, sin secreto.
  const { raw, headers } = signedWebhook(webhookSecret, base('whatsapp.read', {}));
  assert.throws(
    () => provider.parseWebhook(raw.replace('read', 'sent'), headers),
    WebhookSignatureError,
  );
  assert.throws(
    () => provider.parseWebhook(raw, { ...headers, 'webhook-signature': 'v1,AAAA' }),
    WebhookSignatureError,
  );
  const other = signedWebhook(
    `whsec_${randomBytes(24).toString('base64')}`,
    base('whatsapp.read', {}),
  );
  assert.throws(() => provider.parseWebhook(other.raw, other.headers), WebhookSignatureError);
  delete process.env.BIRD_WEBHOOK_SECRET;
  assert.throws(
    () => provider.parseWebhook(raw, headers),
    (e: unknown) => e instanceof WhatsAppProviderError && e.code === 'CONFIG',
  );
});
