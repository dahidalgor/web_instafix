import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { test } from 'node:test';
import type { Request } from 'express';
import { STAFF_SESSION_IDLE_MS, authenticated, cookieName } from '../auth/session';
import { newToken, tokenHash } from '../auth/security';
import { db } from '../database/client';

const enabled = process.env.INSTAFIX_INTEGRATION === '1';

test(
  'sesión del equipo: se renueva con el uso (como en una app); la del cliente no',
  { skip: !enabled },
  async (t) => {
    const make = (role: 'TECHNICIAN' | 'CUSTOMER') =>
      db.user.create({
        data: {
          name: `Sesión ${role}`,
          phone: `+59392${randomInt(1000000, 9999999)}`,
          passwordHash: 'x',
          role,
          phoneVerifiedAt: new Date(),
        },
      });
    const tech = await make('TECHNICIAN');
    const customer = await make('CUSTOMER');
    t.after(() => db.user.deleteMany({ where: { id: { in: [tech.id, customer.id] } } }));
    const login = async (userId: string, expiresInMs: number) => {
      const token = newToken();
      await db.session.create({
        data: {
          userId,
          tokenHash: tokenHash(token),
          expiresAt: new Date(Date.now() + expiresInMs),
        },
      });
      const cookies: string[] = [];
      const req = {
        headers: { cookie: `${cookieName}=${token}` },
        path: '/test',
        res: { cookie: (name: string) => cookies.push(name) },
      } as unknown as Request;
      return { token, req, cookies };
    };
    const expiry = async (token: string) =>
      (await db.session.findUniqueOrThrow({ where: { tokenHash: tokenHash(token) } })).expiresAt;

    // Técnico con 1 h de sesión restante: al usar el panel se extiende a 180 días.
    const staff = await login(tech.id, 3600000);
    await authenticated(staff.req);
    assert.ok((await expiry(staff.token)).getTime() > Date.now() + STAFF_SESSION_IDLE_MS - 60000);
    assert.deepEqual(staff.cookies, [cookieName], 'la cookie también se renueva');
    // Recién renovada: no vuelve a escribir en cada petición.
    await authenticated(staff.req);
    assert.equal(staff.cookies.length, 1);

    // Cliente: su sesión de 24 h no cambia.
    const client = await login(customer.id, 3600000);
    const before = await expiry(client.token);
    await authenticated(client.req);
    assert.equal((await expiry(client.token)).getTime(), before.getTime());
    assert.equal(client.cookies.length, 0);

    // Vencida: sigue pidiendo iniciar sesión.
    const old = await login(tech.id, -1000);
    await assert.rejects(authenticated(old.req), /Inicia sesión/);
  },
);
