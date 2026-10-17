import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { db } from '../database/client';
import { receiveBridgeWebhook, processBridgeWebhook } from '../whatsapp/bridge-webhooks';
import { WhatsAppOnboardingService } from '../whatsapp/onboarding.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { WasapFlowClient } from '../whatsapp/wasapflow.client';

test(
  'WasapFlow onboarding, Coexistence events and service-window isolation',
  { skip: process.env.INSTAFIX_INTEGRATION !== '1' },
  async (t) => {
    const existing = await db.whatsAppConnection.findUnique({ where: { id: 'main' } });
    if (existing?.wabaId || existing?.stateHash) {
      t.skip('Run against an isolated database without a live connection');
      return;
    }
    const saved = { ...process.env },
      originalFetch = globalThis.fetch;
    const prefix = `bridge-test-${randomUUID()}`;
    const wabaId = '987654321098',
      phone = '+593999123452';
    Object.assign(process.env, {
      WASAPFLOW_PARTNER_KEY: 'fixture-partner',
      WASAPFLOW_WABA_ID: wabaId,
      WHATSAPP_ENABLED: 'false',
      WHATSAPP_TEMPLATE_INITIAL: 'instafix_solicitar_ubicacion',
    });
    const calls: string[] = [];
    let cloudOnly = false,
      modeMissing = false,
      sendCount = 0;
    globalThis.fetch = async (url, init) => {
      const path = new URL(String(url)).pathname;
      calls.push(path);
      assert.equal(new Headers(init?.headers).get('x-partner-key'), 'fixture-partner');
      assert.ok(!String(url).includes('fixture-partner'));
      if (path.endsWith('/embedded-signup/config'))
        return Response.json({
          success: true,
          connection_mode: cloudOnly ? 'cloud_api' : 'coexistence',
        });
      if (path.endsWith('/connect/session')) {
        assert.equal(JSON.parse(String(init?.body)).display_name, 'Instafix');
        return Response.json({
          success: true,
          connect_url: 'https://officialapi.wasapflow.com/bridge/connect?token=fixture-session',
          token: 'fixture-session',
          expires_in: 1800,
        });
      }
      if (path.endsWith('/clients'))
        return Response.json({
          success: true,
          clients: [
            {
              waba_id: wabaId,
              status: 'active',
              ...(modeMissing ? {} : { connection_mode: cloudOnly ? 'cloud_api' : 'coexistence' }),
            },
          ],
          total: 1,
        });
      assert.ok(path.endsWith('/messages/template') || path.endsWith('/messages/send'));
      assert.equal(new Headers(init?.headers).get('x-waba-id'), wabaId);
      return Response.json({ success: true, message_id: `${prefix}:out:${++sendCount}` });
    };
    const appointment = await db.appointment.create({
      data: {
        contactName: 'Prueba Bridge',
        contactPhone: phone,
        whatsappConsentAt: new Date(),
        title: 'Mantenimiento completo PS5',
        device: 'PS5',
        startsAt: new Date(Date.now() + 86400000 * 3),
        endsAt: new Date(Date.now() + 86400000 * 3 + 3600000),
        address: '',
        technician: '',
      },
    });
    t.after(async () => {
      globalThis.fetch = originalFetch;
      process.env = saved;
      await db.appointment.delete({ where: { id: appointment.id } });
      await db.bridgeWebhook.deleteMany({ where: { wabaId } });
      await db.whatsAppMessage.deleteMany({ where: { wabaId } });
      await db.whatsAppContact.deleteMany({ where: { wabaId } });
      await db.integrationEvent.deleteMany({
        where: {
          OR: [{ sourceId: { startsWith: prefix } }, { id: { startsWith: `wa:${prefix}` } }],
        },
      });
      if (existing) await db.whatsAppConnection.update({ where: { id: 'main' }, data: existing });
      else await db.whatsAppConnection.deleteMany({ where: { id: 'main' } });
      await db.$disconnect();
    });
    const onboarding = new WhatsAppOnboardingService(new WasapFlowClient());
    cloudOnly = true;
    await assert.rejects(onboarding.start('test-admin'));
    assert.ok(!calls.some((path) => path.endsWith('/connect/session')));
    cloudOnly = false;
    const session = await onboarding.start('test-admin');
    const completion = { state: session.state, waba_id: wabaId, connection_mode: 'coexistence' };
    await assert.rejects(onboarding.complete('other-admin', completion));
    await assert.rejects(
      onboarding.complete('test-admin', { ...completion, connection_mode: 'cloud_api' }),
    );
    cloudOnly = true;
    await assert.rejects(onboarding.complete('test-admin', completion));
    cloudOnly = false;
    modeMissing = true; // The documented list response may omit connection_mode.
    await onboarding.complete('test-admin', completion);
    await assert.rejects(onboarding.complete('test-admin', completion));
    assert.equal(
      (await db.whatsAppConnection.findUniqueOrThrow({ where: { id: 'main' } })).connectionMode,
      'coexistence',
    );

    const message = (event: string, id: string, data = {}) => ({
      event,
      waba_id: wabaId,
      timestamp: Math.floor(Date.now() / 1000),
      data: {
        message_id: `${prefix}:${id}`,
        timestamp: Math.floor(Date.now() / 1000),
        type: 'location',
        from: phone.slice(1),
        recipient: phone.slice(1),
        contact_wa_id: phone.slice(1),
        direction: 'inbound',
        raw: { message: { location: { latitude: -0.2, longitude: -78.5 } } },
        ...data,
      },
    });
    async function ingest(body: unknown) {
      await receiveBridgeWebhook(body);
      for (const row of await db.bridgeWebhook.findMany({ where: { wabaId, status: 'PENDING' } }))
        await processBridgeWebhook(row.id);
    }
    await ingest(message('message.echo', 'echo'));
    await ingest(message('message.history', 'history'));
    assert.equal(
      (await db.appointment.findUniqueOrThrow({ where: { id: appointment.id } }))
        .locationReceivedAt,
      null,
    );
    const service = new WhatsAppService(new WasapFlowClient());
    await assert.rejects(service.sendAppointmentMessage(appointment, 'INITIAL'));
    process.env.WHATSAPP_ENABLED = 'true';
    await assert.rejects(service.replyText(phone, 'Prueba'));
    assert.equal(sendCount, 0);
    await ingest(message('message.received', 'bsuid', { from: null, bsuid: 'EC.123456789' }));
    assert.equal(
      (await db.appointment.findUniqueOrThrow({ where: { id: appointment.id } }))
        .locationReceivedAt,
      null,
    );
    const live = message('message.received', 'live');
    await ingest(live);
    await ingest(live);
    // La ubicación en vivo se guarda; la confirmación la hace después un técnico.
    const located = await db.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
    assert.ok(located.locationReceivedAt);
    assert.equal(located.status, 'PENDING_LOCATION');
    assert.equal(
      await db.automationJob.count({ where: { appointmentId: appointment.id, kind: 'CONFIRMED' } }),
      0,
    );
    assert.equal(
      await db.whatsAppMessage.count({ where: { wabaId, messageId: `${prefix}:live` } }),
      1,
    );
    await ingest(message('message.history', 'live', { timestamp: 1000 }));
    assert.equal(
      (
        await db.whatsAppMessage.findUniqueOrThrow({
          where: { wabaId_messageId: { wabaId, messageId: `${prefix}:live` } },
        })
      ).source,
      'customer_live',
    );
    const sentId = await service.replyText(phone, 'Prueba local');
    assert.equal(sendCount, 1);
    await service.sendAppointmentMessage(appointment, 'INITIAL');
    assert.equal(sendCount, 2);
    await ingest(message('message.read', 'status', { message_id: sentId }));
    await ingest(message('message.sent', 'status', { message_id: sentId }));
    const wrong = message('message.received', 'wrong');
    wrong.waba_id = '111';
    assert.deepEqual(await receiveBridgeWebhook(wrong), { ignored: true });
    await ingest({
      event: 'contact.synced',
      waba_id: wabaId,
      timestamp: Math.floor(Date.now() / 1000),
      data: { action: 'add', phone_number: phone.slice(1), full_name: 'Prueba' },
    });
    assert.equal(await db.whatsAppContact.count({ where: { wabaId } }), 1);
    assert.ok(!calls.some((path) => path.includes('/register') || path.includes('/disconnect')));
  },
);
