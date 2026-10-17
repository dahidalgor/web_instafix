import assert from 'node:assert/strict';
import { test } from 'node:test';
import { db } from '../database/client';
import { ProviderError } from '../integrations/provider-error';
import { connectedWaba } from '../whatsapp/connection';
import { WasapFlowOtpProvider } from '../whatsapp/otp.provider';
import { describeBridgeError, WasapFlowClient } from '../whatsapp/wasapflow.client';

const enabled = process.env.INSTAFIX_INTEGRATION === '1';

test('Bridge errors keep code, Meta code and message but never the partner key', () => {
  const text = describeBridgeError(
    400,
    {
      success: false,
      error: {
        code: 'META_ERROR',
        meta_code: 132001,
        message: 'Template name does not exist in es  for wf_live_secret',
      },
    },
    'wf_live_secret',
  );
  assert.equal(text.includes('META_ERROR'), true);
  assert.equal(text.includes('Meta 132001'), true);
  assert.equal(text.includes('wf_live_secret'), false);
});

// La WABA registrada directamente en WasapFlow (sin el botón de Administración) se adopta
// solo si WasapFlow confirma que pertenece al partner y está activa.
test(
  'OTP send adopts WASAPFLOW_WABA_ID confirmed by WasapFlow and reports the real Meta error',
  { skip: !enabled },
  async () => {
    const saved = await db.whatsAppConnection.findUnique({ where: { id: 'main' } });
    if (saved?.wabaId) return; // No tocar una conexión real de desarrollo.
    const env = { ...process.env };
    const original = globalThis.fetch;
    const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
    let templateResponse: () => Response = () =>
      Response.json({ success: true, message_id: 'wamid.ok' });
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        headers: init?.headers as Record<string, string>,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (url.includes('/clients'))
        return Response.json({
          success: true,
          clients: [{ waba_id: 111222333, status: 'active' }],
          total: 1,
        });
      return templateResponse();
    }) as typeof fetch;
    Object.assign(process.env, {
      WASAPFLOW_PARTNER_KEY: 'wf_test_key',
      WASAPFLOW_BASE_URL: 'https://officialapi.wasapflow.com/bridge/v1/', // con barra final
      WASAPFLOW_WABA_ID: '111222333',
      WHATSAPP_OTP_ENABLED: 'true',
      WHATSAPP_TEMPLATE_OTP: 'instafix_codigo_verificacion',
      WHATSAPP_TEMPLATE_OTP_LANGUAGE: 'es_MX',
    });
    try {
      const provider = new WasapFlowOtpProvider(new WasapFlowClient());
      assert.deepEqual(await provider.sendAuthenticationCode('+593981234519', '123456'), {
        messageId: 'wamid.ok',
      });
      assert.equal(await connectedWaba(), '111222333');
      const send = calls.find((c) => c.url.endsWith('/messages/template'))!;
      assert.equal(send.headers['x-waba-id'], '111222333');
      assert.equal(send.body.to, '593981234519');
      assert.equal(send.body.template.language, 'es_MX');
      templateResponse = () =>
        Response.json(
          {
            success: false,
            error: { code: 'META_ERROR', meta_code: 132001, message: 'Template does not exist' },
          },
          { status: 400 },
        );
      await assert.rejects(
        provider.sendAuthenticationCode('+593981234519', '123456'),
        (e: unknown) => e instanceof ProviderError && e.message.includes('Meta 132001'),
      );
      // Una WABA que WasapFlow no lista nunca se adopta.
      await db.whatsAppConnection.deleteMany({ where: { id: 'main' } });
      process.env.WASAPFLOW_WABA_ID = '999';
      await assert.rejects(
        provider.sendAuthenticationCode('+593981234519', '123456'),
        /no está registrada/,
      );
      assert.equal(await connectedWaba(), null);
    } finally {
      globalThis.fetch = original;
      process.env = env;
      await db.whatsAppConnection.deleteMany({ where: { id: 'main' } });
    }
  },
);
