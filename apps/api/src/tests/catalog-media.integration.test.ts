import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Request } from 'express';
import { mediaProblem, serviceCover } from '@instafix/contracts';
import { newToken, tokenHash } from '../auth/security';
import { CatalogController } from '../catalog/catalog.controller';
import { db } from '../database/client';

const img = (n: number) => ({
  type: 'image' as const,
  url: `https://cdn.instafix.ec/${n}.webp`,
  alt: '',
});
const vid = (n: number) => ({
  type: 'video' as const,
  url: `https://cdn.instafix.ec/${n}.mp4`,
  alt: '',
});

test('carousel rule: at most two videos, never consecutive', () => {
  assert.equal(mediaProblem([vid(1), img(2)]), null);
  assert.equal(mediaProblem([vid(1), img(2), vid(3)]), null);
  assert.match(mediaProblem([img(1), vid(2), vid(3), img(4)])!, /separados/);
  assert.match(mediaProblem([vid(1), img(2), vid(3), img(4), vid(5)])!, /máximo 2/);
});

test('cover falls back to the first photo for older services', () => {
  assert.equal(serviceCover({ cover: null, media: [vid(1), img(2)] })!.url, img(2).url);
  assert.equal(
    serviceCover({ cover: { url: img(9).url, alt: 'Portada' }, media: [img(2)] })!.url,
    img(9).url,
  );
  assert.equal(serviceCover({ cover: null, media: [vid(1)] }), null);
});

test(
  'API is the authority: invalid carousels and covers are rejected; cover can be set, replaced and removed',
  { skip: process.env.INSTAFIX_INTEGRATION !== '1' },
  async () => {
    const controller = new CatalogController();
    const admin = await db.user.create({
      data: {
        name: 'Admin Catálogo',
        phone: `+59397${randomInt(1000000, 9999999)}`,
        passwordHash: 'sin-login',
        role: 'ADMIN',
      },
    });
    const token = newToken();
    await db.session.create({
      data: {
        userId: admin.id,
        tokenHash: tokenHash(token),
        expiresAt: new Date(Date.now() + 60000),
      },
    });
    const req = {
      headers: { origin: 'http://localhost:5173', cookie: `instafix_session=${token}` },
    } as unknown as Request;
    const equipment = await db.equipment.create({
      data: {
        name: `Equipo-${randomUUID()}`,
        category: { connectOrCreate: { where: { name: 'Pruebas' }, create: { name: 'Pruebas' } } },
      },
    });
    const base = {
      equipmentId: equipment.id,
      title: 'Servicio de prueba',
      description: 'Descripción suficientemente larga.',
      priceMinor: 1000,
      durationMinutes: 60,
      warrantyDays: 0,
      availability: 'AVAILABLE' as const,
    };
    let id = '';
    try {
      // Peticiones manipuladas: el backend rechaza aunque el panel no lo hubiera permitido.
      for (const media of [
        [img(1), vid(2), vid(3)],
        [vid(1), img(2), vid(3), img(4), vid(5)],
      ])
        await assert.rejects(
          controller.addService({ ...base, media }, req),
          (e: any) => e.getStatus() === 400,
        );
      await assert.rejects(
        controller.addService({ ...base, media: [], cover: { url: vid(1).url, alt: '' } }, req),
        (e: any) => e.getStatus() === 400,
      );
      await assert.rejects(
        controller.addService(
          { ...base, media: [], cover: { url: 'http://inseguro/x.webp', alt: '' } },
          req,
        ),
        (e: any) => e.getStatus() === 400,
      );
      const created = await controller.addService(
        { ...base, media: [vid(1), img(2), vid(3)], cover: { url: img(7).url, alt: 'Portada' } },
        req,
      );
      id = created.id;
      assert.deepEqual(created.cover, { url: img(7).url, alt: 'Portada' });
      // Editar sin enviar portada la conserva; reemplazar y eliminar funcionan.
      assert.deepEqual((await controller.editService(id, { ...base, media: [] }, req)).cover, {
        url: img(7).url,
        alt: 'Portada',
      });
      const replaced = await controller.editService(
        id,
        { ...base, media: [], cover: { url: img(8).url, alt: '' } },
        req,
      );
      assert.equal((replaced.cover as { url: string }).url, img(8).url);
      assert.equal(
        (await controller.editService(id, { ...base, media: [], cover: null }, req)).cover,
        null,
      );
    } finally {
      if (id) await db.offering.delete({ where: { id } });
      await db.equipment.delete({ where: { id: equipment.id } });
      await db.user.delete({ where: { id: admin.id } });
    }
  },
);
