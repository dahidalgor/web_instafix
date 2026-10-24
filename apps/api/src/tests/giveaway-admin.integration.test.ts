import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { test } from 'node:test';
import type { Request } from 'express';
import { GiveawayAdminController } from '../admin/giveaway-admin.controller';
import { newToken, tokenHash } from '../auth/security';
import { db } from '../database/client';

const enabled = process.env.INSTAFIX_INTEGRATION === '1';
const tag = `Sorteo${randomInt(1e6)}`;

async function person(role: 'ADMIN' | 'TECHNICIAN' | 'CUSTOMER', name: string) {
  const user = await db.user.create({
    data: {
      name,
      phone: `+59396${randomInt(1000000, 9999999)}`,
      passwordHash: 'x',
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
    socket: { remoteAddress: `10.6.${randomInt(0, 255)}.${randomInt(1, 254)}` },
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
  'sorteo en administración: participantes por persona y corrección de visitas',
  { skip: !enabled },
  async () => {
    const giveaway = new GiveawayAdminController();
    const admin = await person('ADMIN', `Admin ${tag}`);
    const tech = await person('TECHNICIAN', `Técnico ${tag}`);
    const customer = await person('CUSTOMER', `Paul ${tag}`);
    const guestPhone = `+59395${randomInt(1000000, 9999999)}`;
    const visit = (data: Record<string, unknown>) =>
      db.appointment.create({
        data: {
          title: 'Par de joysticks',
          device: 'PS5',
          startsAt: new Date(),
          endsAt: new Date(Date.now() + 3600000),
          address: 'Quito',
          technician: tech.user.name,
          contactName: `Paul ${tag}`,
          contactPhone: customer.user.phone,
          completedById: tech.user.id,
          ...data,
        },
      });
    const ids: string[] = [];
    try {
      // Dos visitas del mismo cliente (con cuenta) y una de un invitado.
      const a = await visit({
        userId: customer.user.id,
        status: 'COMPLETED',
        completedAt: new Date(),
        giveawayEntries: 2,
      });
      const b = await visit({
        userId: customer.user.id,
        status: 'COMPLETED',
        completedAt: new Date(),
        giveawayEntries: 1,
      });
      const forgotten = await visit({
        contactName: `Invitado ${tag}`,
        contactPhone: guestPhone,
        status: 'COMPLETED',
        completedAt: new Date(),
      });
      const pending = await visit({ status: 'CONFIRMED' });
      ids.push(a.id, b.id, forgotten.id, pending.id);
      await db.completedJob.create({
        data: {
          userId: customer.user.id,
          appointmentId: a.id,
          title: 'Par de joysticks',
          device: 'PS5',
          completedAt: new Date(),
          warrantyTerms: '—',
          priceMinor: 0,
          giveawayEntries: 2,
        },
      });

      // Solo administración.
      assert.equal(await status(giveaway.participants(tech.req)), 403);
      assert.equal(await status(giveaway.participants(customer.req)), 403);
      assert.equal(await status(giveaway.correct(a.id, { giveawayEntries: 3 }, tech.req)), 403);

      const mine = (await giveaway.participants(admin.req)).participants.filter((p) =>
        p.name.includes(tag),
      );
      assert.equal(mine.length, 1, 'el invitado sin participaciones no aparece');
      assert.equal(mine[0].entries, 3, 'las visitas del mismo cliente se suman');
      assert.equal(mine[0].visits.length, 2);

      // El técnico olvidó marcar: se busca la visita completada y se corrige.
      const found = await giveaway.visits(admin.req, `Invitado ${tag}`);
      assert.deepEqual(
        found.map((v) => v.id),
        [forgotten.id],
      );
      assert.equal((await giveaway.visits(admin.req, guestPhone.slice(-7)))[0]?.id, forgotten.id);
      const fixed = await giveaway.correct(forgotten.id, { giveawayEntries: 2 }, admin.req);
      assert.equal(fixed.giveawayEntries, 2);

      // Corregir una visita con trabajo en Mi cuenta actualiza también el trabajo.
      await giveaway.correct(a.id, { giveawayEntries: 4 }, admin.req);
      assert.equal(
        (await db.completedJob.findFirstOrThrow({ where: { appointmentId: a.id } }))
          .giveawayEntries,
        4,
      );
      const after = (await giveaway.participants(admin.req)).participants.filter((p) =>
        p.name.includes(tag),
      );
      assert.deepEqual(
        after.map((p) => [p.name, p.entries]),
        [
          [`Paul ${tag}`, 5],
          [`Invitado ${tag}`, 2],
        ],
      );
      // Quitar todas las participaciones lo saca de la lista.
      await giveaway.correct(forgotten.id, { giveawayEntries: 0 }, admin.req);
      assert.ok(
        !(await giveaway.participants(admin.req)).participants.some(
          (p) => p.name === `Invitado ${tag}`,
        ),
      );

      // Auditoría y validación.
      assert.equal(
        await db.appointmentActivity.count({
          where: { appointmentId: { in: ids }, action: 'GIVEAWAY_UPDATED' },
        }),
        3,
      );
      assert.equal(
        await status(giveaway.correct(pending.id, { giveawayEntries: 1 }, admin.req)),
        409,
        'solo visitas completadas',
      );
      for (const bad of [
        { giveawayEntries: -1 },
        { giveawayEntries: 21 },
        { giveawayEntries: 1.5 },
        {},
      ])
        assert.equal(await status(giveaway.correct(a.id, bad, admin.req)), 400);
      assert.equal(
        await status(giveaway.correct(a.id, { giveawayEntries: 1, userId: 'x' }, admin.req)),
        400,
      );
      assert.equal(
        await status(
          giveaway.correct(
            '00000000-0000-4000-8000-000000000000',
            { giveawayEntries: 1 },
            admin.req,
          ),
        ),
        404,
      );
    } finally {
      await db.completedJob.deleteMany({ where: { appointmentId: { in: ids } } });
      await db.appointment.deleteMany({ where: { id: { in: ids } } });
      await db.adminAction.deleteMany({ where: { actorId: admin.user.id } });
      await db.user.deleteMany({
        where: { id: { in: [admin.user.id, tech.user.id, customer.user.id] } },
      });
    }
  },
);
