import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { test } from 'node:test';
import type { Request } from 'express';
import { SecurityController } from '../account/security.controller';
import { hashPassword, newToken, tokenHash } from '../auth/security';
import type { VerificationService } from '../auth/verification.service';
import { db } from '../database/client';

const enabled = process.env.INSTAFIX_INTEGRATION === '1';

async function person(role: 'ADMIN' | 'TECHNICIAN' | 'CUSTOMER') {
  const user = await db.user.create({
    data: {
      name: 'Nombre Viejo',
      firstName: 'Nombre',
      lastName: 'Viejo',
      phone: `+59395${randomInt(1000000, 9999999)}`,
      passwordHash: await hashPassword('clave-nombre-123'),
      role,
      phoneVerifiedAt: new Date(),
    },
  });
  const token = newToken();
  await db.session.create({
    data: { userId: user.id, tokenHash: tokenHash(token), expiresAt: new Date(Date.now() + 6e5) },
  });
  const req = {
    headers: { origin: 'http://localhost:5173', cookie: `instafix_session=${token}` },
    socket: { remoteAddress: `10.11.${randomInt(0, 255)}.${randomInt(1, 254)}` },
  } as unknown as Request;
  return { user, req };
}
const status = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return 200;
  } catch (e) {
    return (e as { getStatus?: () => number }).getStatus?.() ?? 500;
  }
};

test(
  'cambiar el nombre de la cuenta: clientes, técnicos y administración',
  { skip: !enabled },
  async (t) => {
    const security = new SecurityController({} as VerificationService);
    const customer = await person('CUSTOMER');
    const tech = await person('TECHNICIAN');
    const admin = await person('ADMIN');
    const ids: string[] = [];
    t.after(async () => {
      await db.appointment.deleteMany({ where: { id: { in: ids } } });
      await db.user.deleteMany({
        where: { id: { in: [customer.user.id, tech.user.id, admin.user.id] } },
      });
    });
    const visit = async (status: string) => {
      const startsAt = new Date(Date.now() + 86400000);
      const row = await db.appointment.create({
        data: {
          title: 'Revisión PS5',
          device: 'PS5',
          startsAt,
          endsAt: new Date(startsAt.getTime() + 7200000),
          address: '',
          contactPhone: customer.user.phone,
          contactName: 'Nombre Viejo',
          userId: customer.user.id,
          assignedTechnicianId: tech.user.id,
          technician: 'Nombre Viejo',
          status: status as never,
        },
      });
      ids.push(row.id);
      return row;
    };
    const active = await visit('CONFIRMED');
    const done = await visit('COMPLETED');

    // Se normaliza como en el registro: mayúsculas iniciales y espacios.
    const updated = await security.changeName(
      { firstName: '  maría   josé ', lastName: "o'neil-pérez" },
      customer.req,
    );
    assert.equal(updated.name, "María José O'Neil-Pérez");
    assert.equal(updated.firstName, 'María José');
    assert.equal(updated.lastName, "O'Neil-Pérez");
    // Técnicos y administradores también.
    assert.equal(
      (await security.changeName({ firstName: 'Carlos', lastName: 'Mena' }, tech.req)).name,
      'Carlos Mena',
    );
    assert.equal(
      (await security.changeName({ firstName: 'David', lastName: 'Hidalgo' }, admin.req)).name,
      'David Hidalgo',
    );

    // Las citas activas muestran el nombre nuevo; las terminadas conservan el historial.
    const now = await db.appointment.findUniqueOrThrow({ where: { id: active.id } });
    assert.equal(now.contactName, "María José O'Neil-Pérez");
    assert.equal(now.technician, 'Carlos Mena');
    const history = await db.appointment.findUniqueOrThrow({ where: { id: done.id } });
    assert.equal(history.contactName, 'Nombre Viejo');
    assert.equal(history.technician, 'Nombre Viejo');

    // Validación: letras, 2–50 caracteres, sin campos extra; sin sesión, nada.
    for (const body of [
      { firstName: 'A', lastName: 'Mena' },
      { firstName: 'Carlos3', lastName: 'Mena' },
      { firstName: 'Carlos', lastName: 'x'.repeat(51) },
      { firstName: 'Carlos', lastName: 'Mena', role: 'ADMIN' },
      { firstName: 'Carlos' },
    ])
      assert.equal(await status(security.changeName(body, tech.req)), 400);
    const anonymous = { headers: { origin: 'http://localhost:5173' } } as unknown as Request;
    assert.equal(
      await status(security.changeName({ firstName: 'Ana', lastName: 'Ruiz' }, anonymous)),
      401,
    );
    assert.equal(
      (await db.user.findUniqueOrThrow({ where: { id: tech.user.id } })).name,
      'Carlos Mena',
    );
  },
);
