import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AppModule } from '../app.module';
import { db } from '../database/client';
import { newToken, tokenHash } from '../auth/security';

test(
  'HTTP webhooks verify raw signatures and admin endpoints require the admin role',
  { skip: process.env.INSTAFIX_INTEGRATION !== '1' },
  async (t) => {
    const saved = { ...process.env };
    Object.assign(process.env, {
      WHATSAPP_ENABLED: 'false',
      WASAPFLOW_WEBHOOK_SECRET: 'test-secret',
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
          [path === 'cal' ? 'x-cal-signature-256' : 'x-wasapflow-signature']: signature || '',
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
    const ignored = JSON.stringify({
      event: 'message.received',
      waba_id: '998877',
      timestamp: Math.floor(Date.now() / 1000),
      data: { message_id: 'http-fixture' },
    });
    assert.equal((await signedPost('wasapflow', ignored)).status, 403);
    assert.equal(
      (
        await signedPost(
          'wasapflow',
          ignored,
          'sha256=' + createHmac('sha256', 'test-secret').update(ignored).digest('hex'),
        )
      ).status,
      200,
    );
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
