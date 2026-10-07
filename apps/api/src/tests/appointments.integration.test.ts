import { PrismaClient } from '@prisma/client';
import { config } from 'dotenv';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { newToken, tokenHash } from '../auth/security';
config({ path: '../../.env' });

test(
  'appointment ownership, admin permissions and persistent updates',
  { skip: process.env.INSTAFIX_INTEGRATION !== '1' },
  async () => {
    const db = new PrismaClient();
    const ids: string[] = [];
    const tokens: string[] = [];
    const base = process.env.INSTAFIX_TEST_API ?? 'http://127.0.0.1:3001/api/v1';
    async function call(path: string, token = '', method = 'GET', body?: unknown) {
      return fetch(`${base}/${path}`, {
        method,
        headers: {
          Origin: 'http://localhost:5173',
          'Content-Type': 'application/json',
          Cookie: `instafix_session=${token}`,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    }
    try {
      for (const role of ['CUSTOMER', 'CUSTOMER', 'ADMIN'] as const) {
        const user = await db.user.create({
          data: {
            name: 'Prueba aislada de citas',
            phone: `test-${randomUUID()}`,
            passwordHash: 'no-login-test',
            role,
          },
        });
        ids.push(user.id);
        const token = newToken();
        tokens.push(token);
        await db.session.create({
          data: {
            userId: user.id,
            tokenHash: tokenHash(token),
            expiresAt: new Date(Date.now() + 60000),
          },
        });
      }
      assert.equal((await call('my/appointments')).status, 401);
      assert.equal((await call('admin/appointments', tokens[0])).status, 403);
      const body = {
        userId: ids[0],
        title: 'Cita de prueba aislada',
        device: 'PS5',
        startsAt: '2026-11-10T10:00:00-05:00',
        endsAt: '2026-11-10T11:00:00-05:00',
        timeZone: 'America/Guayaquil',
        address: 'Dirección de prueba',
        technician: 'Técnico de prueba',
        status: 'CONFIRMED',
      };
      const created = await call('admin/appointments', tokens[2], 'POST', body);
      assert.equal(created.status, 201);
      const item = await created.json();
      const mine = await (await call('my/appointments', tokens[0])).json();
      const others = await (await call('my/appointments', tokens[1])).json();
      assert.equal(mine.length, 1);
      assert.equal(mine[0].id, item.id);
      assert.equal(others.length, 0);
      assert.equal(
        (
          await call(`admin/appointments/${item.id}`, tokens[0], 'PATCH', {
            ...body,
            status: 'CANCELLED',
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await call(`admin/appointments/${item.id}`, tokens[2], 'PATCH', {
            ...body,
            userId: ids[1],
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await call(`admin/appointments/${item.id}`, tokens[2], 'PATCH', {
            ...body,
            status: 'CANCELLED',
          })
        ).status,
        200,
      );
      assert.equal(
        (await db.appointment.findUniqueOrThrow({ where: { id: item.id } })).status,
        'CANCELLED',
      );
    } finally {
      await db.appointment.deleteMany({ where: { userId: { in: ids } } });
      await db.session.deleteMany({ where: { userId: { in: ids } } });
      await db.user.deleteMany({ where: { id: { in: ids } } });
      await db.$disconnect();
    }
  },
);
