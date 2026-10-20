import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AppModule } from '../app.module';
import { db } from '../database/client';
import { newToken, tokenHash } from '../auth/security';
import { signedWebhook, webhookSecret } from './support/bird-webhooks';

test(
  'HTTP webhooks verify raw signatures and admin endpoints require the admin role',
  { skip: process.env.INSTAFIX_INTEGRATION !== '1' },
  async (t) => {
    const saved = { ...process.env };
    Object.assign(process.env, {
      WHATSAPP_ENABLED: 'false',
      BIRD_WEBHOOK_SECRET: webhookSecret,
      CAL_WEBHOOK_SECRET: 'test-secret',
      CAL_EVENT_TYPE_ID: '987654320',
    });
    const app = await NestFactory.create(AppModule, { rawBody: true, logger: false });
    await app.listen(0, '127.0.0.1');
    const base = `${await app.getUrl()}/api/v1`;
    const uid = `http-test-${randomUUID()}`;
    const user = await db.user.create({
      data: { name: 'Prueba HTTP', phone: uid, passwordHash: 'not-login', role: 'CUSTOMER' },
    });
    const token = newToken();
    await db.session.create({
      data: {
        userId: user.id,
        tokenHash: tokenHash(token),
        expiresAt: new Date(Date.now() + 60000),
      },
    });
    t.after(async () => {
      await app.close();
      await db.appointment.deleteMany({ where: { calUid: uid } });
      await db.integrationEvent.deleteMany({ where: { sourceId: uid } });
      await db.session.deleteMany({ where: { userId: user.id } });
      await db.user.delete({ where: { id: user.id } });
      process.env = saved;
      await db.$disconnect();
    });
    const signedPost = (path: string, raw: string, signature?: string) =>
      fetch(`${base}/webhooks/${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-cal-signature-256': signature || '',
        },
        body: raw,
      });
    const payload = JSON.stringify(
      {
        triggerEvent: 'BOOKING_REQUESTED',
        createdAt: new Date().toISOString(),
        payload: {
          uid,
          eventTypeId: 987654320,
          startTime: new Date(Date.now() + 86400000).toISOString(),
          endTime: new Date(Date.now() + 90000000).toISOString(),
          attendees: [{ name: 'Prueba HTTP' }],
        },
      },
      null,
      2,
    );
    const signature = createHmac('sha256', 'test-secret').update(payload).digest('hex');
    assert.equal((await signedPost('cal', payload)).status, 403);
    assert.equal((await signedPost('cal', payload + ' ', signature)).status, 403);
    assert.equal((await signedPost('cal', payload, signature)).status, 200);
    assert.equal((await signedPost('cal', payload, signature)).status, 200);
    assert.equal(await db.appointment.count({ where: { calUid: uid } }), 1);
    // Bird: firma Standard Webhooks sobre el cuerpo crudo; un reintento (mismo webhook-id) no
    // crea otra fila en la bandeja.
    const birdPost = (raw: string, headers: Record<string, string>) =>
      fetch(`${base}/webhooks/bird`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: raw,
      });
    const deliveryId = `msg_${uid}`;
    const delivered = signedWebhook(
      webhookSecret,
      {
        type: 'whatsapp.delivered',
        timestamp: new Date().toISOString(),
        data: {
          whatsapp_id: `wam_${uid}`,
          workspace_id: 'ws_test',
          direction: 'outbound',
          from: { phone_number: '+593984703819' },
          to: { phone_number: '+593998686244' },
          tags: null,
          metadata: null,
        },
      },
      deliveryId,
    );
    t.after(() =>
      db.whatsAppWebhook.deleteMany({ where: { id: `BIRD:${deliveryId}` } }).then(() => undefined),
    );
    assert.equal((await birdPost(delivered.raw, {})).status, 403);
    assert.equal((await birdPost(delivered.raw + ' ', delivered.headers)).status, 403);
    assert.equal((await birdPost(delivered.raw, delivered.headers)).status, 200);
    assert.equal((await birdPost(delivered.raw, delivered.headers)).status, 200);
    assert.equal(await db.whatsAppWebhook.count({ where: { id: `BIRD:${deliveryId}` } }), 1);
    assert.equal((await signedPost('wasapflow', '{}')).status, 404);
    assert.equal((await fetch(`${base}/webhooks/whatsapp`)).status, 404);
    assert.equal((await fetch(`${base}/admin/whatsapp`)).status, 401);
    assert.equal(
      (await fetch(`${base}/admin/whatsapp`, { headers: { Cookie: `instafix_session=${token}` } }))
        .status,
      403,
    );
    await db.user.update({ where: { id: user.id }, data: { role: 'ADMIN' } });
    const overview = await fetch(`${base}/admin/whatsapp`, {
      headers: { Cookie: `instafix_session=${token}` },
    });
    assert.equal(overview.status, 200);
    assert.ok(!(await overview.text()).includes('test-secret'));
  },
);
