import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { test } from 'node:test';
import type { Request } from 'express';
import { GiveawayAdminController } from '../giveaways/giveaway-admin.controller';
import { newToken, tokenHash } from '../auth/security';
import { db } from '../database/client';
import { closeOpenGiveaways } from './giveaway-helpers';

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

const inDays = (days: number) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Guayaquil' }).format(
    new Date(Date.now() + days * 86400000),
  );

test(
  'sorteos en administración: crear (uno abierto a la vez), participantes, corrección y cierre',
  { skip: !enabled },
  async () => {
    const controller = new GiveawayAdminController();
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
    const giveaways: string[] = [];
    await closeOpenGiveaways();
    try {
      // Solo administración.
      const input = {
        prize: `Premio ${tag}`,
        drawDate: inDays(10),
        entryRule: 'Una participación por cada mando con par de joysticks.',
        maxEntries: 5,
      };
      assert.equal(await status(controller.create(input, tech.req)), 403);
      assert.equal(await status(controller.list(customer.req)), 403);

      // Validación: premio, fecha pasada, regla corta, campos extra, servicio inexistente.
      for (const bad of [
        { ...input, prize: 'X' },
        { ...input, drawDate: inDays(-1) },
        { ...input, entryRule: 'corta' },
        { ...input, maxEntries: 0 },
        { ...input, extra: true },
        { ...input, eligibleOfferingIds: ['no-existe'] },
      ])
        assert.equal(await status(controller.create(bad, admin.req)), 400);

      const created = await controller.create(input, admin.req);
      giveaways.push(created.id);
      assert.equal(created.open, true);
      // Solo uno abierto a la vez.
      assert.equal(
        await status(controller.create({ ...input, prize: `Otro ${tag}` }, admin.req)),
        409,
      );

      // Dos visitas del mismo cliente (con cuenta) en este sorteo y una de un invitado sin marcar.
      const inThis = { status: 'COMPLETED', completedAt: new Date(), giveawayId: created.id };
      const a = await visit({ ...inThis, userId: customer.user.id, giveawayEntries: 2 });
      const b = await visit({ ...inThis, userId: customer.user.id, giveawayEntries: 1 });
      const forgotten = await visit({
        contactName: `Invitado ${tag}`,
        contactPhone: guestPhone,
        status: 'COMPLETED',
        completedAt: new Date(),
      });
      const pending = await visit({ status: 'CONFIRMED' });
      // Una visita que participa en el sorteo anterior (GTA VI) no se pasa a este.
      const previous = await visit({
        status: 'COMPLETED',
        completedAt: new Date(),
        giveawayId: 'gta-vi-2026',
        giveawayEntries: 1,
        contactName: `Anterior ${tag}`,
      });
      ids.push(a.id, b.id, forgotten.id, pending.id, previous.id);
      await db.completedJob.create({
        data: {
          userId: customer.user.id,
          appointmentId: a.id,
          title: 'Par de joysticks',
          device: 'PS5',
          completedAt: new Date(),
          warrantyTerms: '—',
          priceMinor: 0,
          giveawayId: created.id,
          giveawayEntries: 2,
        },
      });

      let detail = await controller.participants(created.id, admin.req);
      assert.equal(detail.people.length, 1, 'el invitado sin participaciones no aparece');
      assert.equal(detail.people[0].entries, 3, 'las visitas del mismo cliente se suman');
      assert.equal(detail.totalEntries, 3);
      const listed = (await controller.list(admin.req)).find((g) => g.id === created.id)!;
      assert.equal(listed.totalEntries, 3);
      // El sorteo de GTA VI sigue en la lista, cerrado y con sus participaciones.
      const gta = (await controller.list(admin.req)).find((g) => g.id === 'gta-vi-2026');
      assert.equal(gta?.open, false);

      // El técnico olvidó marcar: se busca la visita completada y se corrige.
      const found = await controller.visits(created.id, admin.req, `Invitado ${tag}`);
      assert.deepEqual(
        found.map((v) => v.id),
        [forgotten.id],
      );
      assert.equal(
        (await controller.visits(created.id, admin.req, guestPhone.slice(-7)))[0]?.id,
        forgotten.id,
      );
      const fixed = await controller.correct(
        created.id,
        forgotten.id,
        { giveawayEntries: 2 },
        admin.req,
      );
      assert.equal(fixed.giveawayEntries, 2);
      assert.equal(
        (await db.appointment.findUniqueOrThrow({ where: { id: forgotten.id } })).giveawayId,
        created.id,
      );
      // Corregir una visita con trabajo en Mi cuenta actualiza también el trabajo.
      await controller.correct(created.id, a.id, { giveawayEntries: 4 }, admin.req);
      assert.equal(
        (await db.completedJob.findFirstOrThrow({ where: { appointmentId: a.id } }))
          .giveawayEntries,
        4,
      );
      detail = await controller.participants(created.id, admin.req);
      assert.deepEqual(
        detail.people.map((p) => [p.name, p.entries]),
        [
          [`Paul ${tag}`, 5],
          [`Invitado ${tag}`, 2],
        ],
      );
      // Quitar todas las participaciones lo saca de la lista (y del sorteo).
      await controller.correct(created.id, forgotten.id, { giveawayEntries: 0 }, admin.req);
      assert.ok(
        !(await controller.participants(created.id, admin.req)).people.some(
          (p) => p.name === `Invitado ${tag}`,
        ),
      );
      assert.equal(
        (await db.appointment.findUniqueOrThrow({ where: { id: forgotten.id } })).giveawayId,
        null,
      );

      // Validación y reglas.
      assert.equal(
        await status(controller.correct(created.id, pending.id, { giveawayEntries: 1 }, admin.req)),
        409,
        'solo visitas completadas',
      );
      assert.equal(
        await status(
          controller.correct(created.id, previous.id, { giveawayEntries: 1 }, admin.req),
        ),
        409,
        'ya participa en otro sorteo',
      );
      for (const bad of [
        { giveawayEntries: -1 },
        { giveawayEntries: 6 },
        { giveawayEntries: 1.5 },
        {},
        { giveawayEntries: 1, userId: 'x' },
      ])
        assert.equal(await status(controller.correct(created.id, a.id, bad, admin.req)), 400);
      assert.equal(
        await status(
          controller.correct(
            created.id,
            '00000000-0000-4000-8000-000000000000',
            { giveawayEntries: 1 },
            admin.req,
          ),
        ),
        404,
      );
      assert.equal(
        await db.appointmentActivity.count({
          where: { appointmentId: { in: ids }, action: 'GIVEAWAY_UPDATED' },
        }),
        3,
      );

      // Cerrar: ya no se corrige, las participaciones se conservan y se puede crear otro.
      const closed = await controller.close(created.id, admin.req);
      assert.equal(closed.open, false);
      assert.equal(closed.totalEntries, 5);
      assert.equal(
        await status(controller.correct(created.id, a.id, { giveawayEntries: 1 }, admin.req)),
        409,
      );
      const next = await controller.create({ ...input, prize: `Siguiente ${tag}` }, admin.req);
      giveaways.push(next.id);
      assert.equal(next.open, true);
    } finally {
      await db.completedJob.deleteMany({ where: { appointmentId: { in: ids } } });
      await db.appointment.deleteMany({ where: { id: { in: ids } } });
      await db.giveaway.deleteMany({ where: { id: { in: giveaways } } });
      await db.adminAction.deleteMany({ where: { actorId: admin.user.id } });
      await db.user.deleteMany({
        where: { id: { in: [admin.user.id, tech.user.id, customer.user.id] } },
      });
    }
  },
);
