import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { db } from '../database/client';
import { receiveCalWebhook } from '../integrations/cal-webhook';
import { BirdWhatsAppProvider } from '../whatsapp/bird/bird.provider';
import { processWhatsAppWebhook, receiveWhatsAppWebhook } from '../whatsapp/webhook-inbox';
import { processJob } from '../whatsapp/worker';
import { signedWebhook, webhookSecret } from './support/bird-webhooks';

test(
  'Bird webhooks → inbox → delivery status, customer location and Coexistence echoes',
  { skip: process.env.INSTAFIX_INTEGRATION !== '1' },
  async (t) => {
    const prefix = `bird-${randomUUID()}`;
    const saved = { ...process.env };
    Object.assign(process.env, {
      CAL_EVENT_TYPE_ID: '987654322',
      WHATSAPP_ENABLED: 'false',
      BIRD_WEBHOOK_SECRET: webhookSecret,
    });
    const provider = new BirdWhatsAppProvider();
    const phone = `+59399${Math.floor(1000000 + Math.random() * 8999999)}`;
    const start = new Date(Date.now() + 3 * 86400000);
    start.setUTCHours(16, 0, 0, 0);
    const webhookIds: string[] = [];
    t.after(async () => {
      await db.appointment.deleteMany({ where: { calUid: { startsWith: prefix } } });
      await db.whatsAppWebhook.deleteMany({ where: { id: { in: webhookIds } } });
      await db.whatsAppMessage.deleteMany({ where: { phone } });
      await db.integrationEvent.deleteMany({
        where: { OR: [{ sourceId: { startsWith: prefix } }, { sourceId: phone }] },
      });
      process.env = saved;
      await db.$disconnect();
    });
    const book = async (uid: string) => {
      await receiveCalWebhook({
        triggerEvent: 'BOOKING_REQUESTED',
        createdAt: new Date().toISOString(),
        payload: {
          uid,
          eventTypeId: 987654322,
          startTime: start.toISOString(),
          endTime: new Date(start.getTime() + 3600000).toISOString(),
          attendees: [{ name: 'Cliente Bird', phoneNumber: phone }],
          responses: { servicio: { value: 'PS5 se apaga' }, whatsappConsent: { value: true } },
        },
      });
      return db.appointment.findUniqueOrThrow({ where: { calUid: uid } });
    };
    // Recibe un webhook firmado tal como lo envía Bird y lo procesa desde la bandeja.
    const deliver = async (type: string, data: Record<string, unknown>) => {
      const id = `msg_${randomUUID()}`;
      webhookIds.push(`BIRD:${id}`);
      const { raw, headers } = signedWebhook(
        webhookSecret,
        {
          type,
          timestamp: new Date().toISOString(),
          data: { workspace_id: 'ws_test', tags: null, metadata: null, ...data },
        },
        id,
      );
      const first = await receiveWhatsAppWebhook(provider, Buffer.from(raw), headers);
      // Reintento de Bird con el mismo webhook-id: no se procesa dos veces.
      await receiveWhatsAppWebhook(provider, Buffer.from(raw), headers);
      await processWhatsAppWebhook(`BIRD:${id}`);
      await processWhatsAppWebhook(`BIRD:${id}`);
      return first;
    };
    const outbound = (whatsappId: string) => ({
      whatsapp_id: whatsappId,
      direction: 'outbound',
      from: { phone_number: '+593984703819' },
      to: { phone_number: phone },
    });
    const inbound = (whatsappId: string, extra: Record<string, unknown>) => ({
      whatsapp_id: whatsappId,
      direction: 'inbound',
      from: { phone_number: phone },
      to: { phone_number: '+593984703819' },
      ...extra,
    });

    // 1. Se envía el aviso inicial (pide la ubicación) y Bird lo acepta.
    const first = await book(`${prefix}:first`);
    const job = await db.automationJob.findFirstOrThrow({
      where: { appointmentId: first.id, kind: 'INITIAL' },
    });
    const wamId = `wam_${prefix}_1`;
    await processJob(job.id, {
      send: async () => ({ providerMessageId: wamId, provider: 'BIRD' }),
      confirm: async () => {},
    });
    const accepted = await db.automationJob.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(accepted.status, 'SENT');
    assert.equal(accepted.deliveryStatus, null); // aceptado ≠ entregado

    // 2. Estados normalizados por webhook; uno anterior no retrocede el estado.
    assert.deepEqual(await deliver('whatsapp.accepted', outbound(wamId)), { ignored: true });
    await deliver('whatsapp.delivered', outbound(wamId));
    assert.equal(
      (await db.automationJob.findUniqueOrThrow({ where: { id: job.id } })).deliveryStatus,
      'DELIVERED',
    );
    await deliver('whatsapp.read', outbound(wamId));
    await deliver('whatsapp.sent', outbound(wamId));
    assert.equal(
      (await db.automationJob.findUniqueOrThrow({ where: { id: job.id } })).deliveryStatus,
      'READ',
    );

    // 3. Un eco de la app Business con ubicación NO es el cliente: no toca la cita.
    await deliver('whatsapp.received', {
      ...outbound(`wam_${prefix}_echo`),
      origin: 'business_app_echo',
      location: { latitude: -1, longitude: -79 },
    });
    assert.equal(
      (await db.appointment.findUniqueOrThrow({ where: { id: first.id } })).locationReceivedAt,
      null,
    );
    // Tampoco el historial sincronizado.
    await deliver(
      'whatsapp.received',
      inbound(`wam_${prefix}_hist`, {
        origin: 'history_sync',
        location: { latitude: -1, longitude: -79 },
      }),
    );
    assert.equal(
      (await db.appointment.findUniqueOrThrow({ where: { id: first.id } })).locationReceivedAt,
      null,
    );

    // 4. El cliente responde al aviso con su ubicación: se guarda en la cita (sin confirmarla).
    await deliver(
      'whatsapp.received',
      inbound(`wam_${prefix}_loc`, {
        in_reply_to_message_id: wamId,
        location: { latitude: -0.18, longitude: -78.48, address: 'Av. Amazonas N24' },
      }),
    );
    const located = await db.appointment.findUniqueOrThrow({ where: { id: first.id } });
    assert.ok(located.locationReceivedAt);
    assert.equal(located.address, 'Av. Amazonas N24');
    assert.equal(located.status, 'PENDING_LOCATION');

    // 5. Historial de chat con fuente y tipo; el texto entrante se guarda.
    await deliver('whatsapp.received', inbound(`wam_${prefix}_txt`, { text: { body: 'Gracias' } }));
    const history = await db.whatsAppMessage.findMany({
      where: { phone },
      orderBy: { occurredAt: 'asc' },
    });
    assert.deepEqual(
      history.map((m) => [m.provider, m.source, m.type]).sort(),
      [
        ['BIRD', 'business_app', 'location'],
        ['BIRD', 'customer_live', 'location'],
        ['BIRD', 'customer_live', 'text'],
        ['BIRD', 'history', 'location'],
      ].sort(),
    );
    assert.equal(history.find((m) => m.type === 'text')?.text, 'Gracias');

    // 6. Fallo de entrega: estado FAILED con el código de Meta, listo para reintentar.
    const second = await book(`${prefix}:second`);
    const secondJob = await db.automationJob.findFirstOrThrow({
      where: { appointmentId: second.id, kind: 'INITIAL' },
    });
    const failedId = `wam_${prefix}_2`;
    await processJob(secondJob.id, {
      send: async () => ({ providerMessageId: failedId, provider: 'BIRD' }),
      confirm: async () => {},
    });
    await deliver('whatsapp.failed', {
      ...outbound(failedId),
      error: {
        code: 'undeliverable',
        description: '(#100) Invalid parameter',
        meta_error_code: '100',
        occurred_at: new Date().toISOString(),
      },
    });
    const failed = await db.automationJob.findUniqueOrThrow({ where: { id: secondJob.id } });
    assert.equal(failed.deliveryStatus, 'FAILED');
    assert.match(failed.lastError || '', /undeliverable, Meta 100/);
    // La bandeja quedó vacía de contenido tras procesar.
    const rows = await db.whatsAppWebhook.findMany({ where: { id: { in: webhookIds } } });
    assert.ok(rows.every((r) => r.status === 'DONE' && JSON.stringify(r.payload) === '{}'));
  },
);
