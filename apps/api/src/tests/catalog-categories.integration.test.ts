import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Request } from 'express';
import { hashPassword, newToken, tokenHash } from '../auth/security';
import { CatalogController } from '../catalog/catalog.controller';
import { db } from '../database/client';

const enabled = process.env.INSTAFIX_INTEGRATION === '1';
async function session(role: 'ADMIN' | 'CUSTOMER') {
  const user = await db.user.create({
    data: {
      name: `${role} Catálogo`,
      phone: `+59399${randomInt(1000000, 9999999)}`,
      passwordHash: await hashPassword('clave-muy-segura-1'),
      role,
      phoneVerifiedAt: new Date(),
    },
  });
  const token = newToken();
  await db.session.create({
    data: {
      userId: user.id,
      tokenHash: tokenHash(token),
      expiresAt: new Date(Date.now() + 600000),
    },
  });
  return {
    user,
    req: {
      headers: { origin: 'http://localhost:5173', cookie: `instafix_session=${token}` },
    } as unknown as Request,
  };
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
  'categories → equipment → services: admin only, unique names, protected deletes',
  { skip: !enabled },
  async () => {
    const catalog = new CatalogController();
    const admin = await session('ADMIN');
    const customer = await session('CUSTOMER');
    const tag = randomUUID().slice(0, 8);
    const ids: { category?: string; other?: string; equipment?: string; offering?: string } = {};
    try {
      // Solo administración; los campos no previstos se rechazan.
      assert.equal(await status(catalog.addCategory({ name: `C ${tag}` }, customer.req)), 403);
      assert.equal(
        await status(catalog.addCategory({ name: `C ${tag}`, id: 'x' }, admin.req)),
        400,
      );
      const category = await catalog.addCategory({ name: `Consolas ${tag}` }, admin.req);
      ids.category = category.id;
      assert.equal(await status(catalog.addCategory({ name: `Consolas ${tag}` }, admin.req)), 409);
      const other = await catalog.addCategory({ name: `PC ${tag}` }, admin.req);
      ids.other = other.id;

      assert.equal(
        await status(catalog.addEquipment({ name: `Eq ${tag}`, categoryId: 'nope' }, admin.req)),
        404,
      );
      const equipment = await catalog.addEquipment(
        { name: `PS5 ${tag}`, categoryId: category.id },
        admin.req,
      );
      ids.equipment = equipment.id;
      const offering = await catalog.addService(
        {
          equipmentId: equipment.id,
          title: 'Mantenimiento de prueba',
          description: 'Descripción suficientemente larga.',
          priceMinor: 1000,
          durationMinutes: 60,
          warrantyDays: 0,
          availability: 'AVAILABLE',
          media: [],
        },
        admin.req,
      );
      ids.offering = offering.id;
      assert.equal(offering.category, `Consolas ${tag}`);
      assert.equal(offering.device, `PS5 ${tag}`);

      // Con contenido no se puede borrar: no se pierden servicios ni historial.
      assert.equal(await status(catalog.removeCategory(category.id, admin.req)), 409);
      assert.equal(await status(catalog.removeEquipment(equipment.id, admin.req)), 409);

      // Renombrar la categoría o mover el equipo actualiza la copia en los servicios.
      await catalog.editCategory(
        category.id,
        { name: `Consolas de Videojuegos ${tag}` },
        admin.req,
      );
      let saved = await db.offering.findUniqueOrThrow({ where: { id: offering.id } });
      assert.equal(saved.category, `Consolas de Videojuegos ${tag}`);
      await catalog.editEquipment(equipment.id, { categoryId: other.id }, admin.req);
      saved = await db.offering.findUniqueOrThrow({ where: { id: offering.id } });
      assert.equal(saved.category, `PC ${tag}`);

      // Una categoría vacía sí se puede eliminar.
      const empty = await catalog.addCategory({ name: `Vacía ${tag}` }, admin.req);
      assert.equal(await status(catalog.removeCategory(empty.id, admin.req)), 200);
      const listed = await catalog.categories();
      assert.ok(!listed.some((item) => item.id === empty.id));
      assert.ok(listed.some((item) => item.id === category.id));
    } finally {
      if (ids.offering) await db.offering.delete({ where: { id: ids.offering } });
      if (ids.equipment) await db.equipment.delete({ where: { id: ids.equipment } });
      await db.serviceCategory.deleteMany({
        where: { id: { in: [ids.category, ids.other].filter(Boolean) as string[] } },
      });
      await db.session.deleteMany({ where: { userId: { in: [admin.user.id, customer.user.id] } } });
      await db.user.deleteMany({ where: { id: { in: [admin.user.id, customer.user.id] } } });
    }
  },
);
