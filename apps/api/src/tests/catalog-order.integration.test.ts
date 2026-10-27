import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Request } from 'express';
import { hashPassword, newToken, tokenHash } from '../auth/security';
import type { StaffUser } from '../auth/session';
import { CatalogController } from '../catalog/catalog.controller';
import { db } from '../database/client';
import { pendingAppointments, staffAppointment } from '../staff/staff-appointments.service';

const enabled = process.env.INSTAFIX_INTEGRATION === '1';
const tag = randomUUID().slice(0, 6);

async function person(role: 'ADMIN' | 'TECHNICIAN' | 'CUSTOMER') {
  const user = await db.user.create({
    data: {
      name: `${role} Orden ${tag}`,
      phone: `+59393${randomInt(1000000, 9999999)}`,
      passwordHash: await hashPassword('clave-orden-123'),
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
    socket: { remoteAddress: `10.5.${randomInt(0, 255)}.${randomInt(1, 254)}` },
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
  'orden del catálogo: equipos dentro de su categoría y servicios dentro de su equipo',
  { skip: !enabled },
  async () => {
    const catalog = new CatalogController();
    const admin = await person('ADMIN');
    const customer = await person('CUSTOMER');
    const category = await catalog.addCategory({ name: `Consolas ${tag}` }, admin.req);
    const other = await catalog.addCategory({ name: `PC ${tag}` }, admin.req);
    try {
      // Los nuevos van al final de su lista.
      const ps5 = await catalog.addEquipment(
        { name: `PS5 ${tag}`, categoryId: category.id },
        admin.req,
      );
      const xbox = await catalog.addEquipment(
        { name: `Xbox ${tag}`, categoryId: category.id },
        admin.req,
      );
      const sw = await catalog.addEquipment(
        { name: `Switch ${tag}`, categoryId: category.id },
        admin.req,
      );
      const laptop = await catalog.addEquipment(
        { name: `Laptop ${tag}`, categoryId: other.id },
        admin.req,
      );
      assert.deepEqual([ps5.position, xbox.position, sw.position], [0, 1, 2]);
      assert.equal(laptop.position, 0, 'cada categoría tiene su propio orden');

      const base = {
        description: 'Servicio de prueba de orden',
        durationMinutes: 60,
        warrantyDays: 0,
        availability: 'AVAILABLE',
        media: [],
      };
      const add = (title: string, equipmentId: string, priceMinor = 1000) =>
        catalog.addService(
          { ...base, title: `${title} ${tag}`, equipmentId, priceMinor },
          admin.req,
        );
      const a = await add('Mantenimiento', ps5.id);
      const b = await add('Joysticks', ps5.id);
      const c = await add('HDMI', ps5.id);
      const x = await add('Limpieza', xbox.id);
      assert.deepEqual([a.position, b.position, c.position, x.position], [0, 1, 2, 0]);

      // Solo administración; la lista debe estar completa y sin repetidos.
      assert.equal(
        await status(
          catalog.orderEquipment(category.id, { ids: [sw.id, ps5.id, xbox.id] }, customer.req),
        ),
        403,
      );
      for (const ids of [
        [sw.id, ps5.id],
        [sw.id, ps5.id, ps5.id],
        [sw.id, ps5.id, laptop.id],
      ])
        assert.equal(await status(catalog.orderEquipment(category.id, { ids }, admin.req)), 409);
      assert.equal(await status(catalog.orderEquipment(category.id, { ids: [] }, admin.req)), 400);
      assert.equal(
        await status(catalog.orderServices(ps5.id, { ids: [c.id, a.id] }, admin.req)),
        409,
      );
      assert.equal(
        await status(catalog.orderServices(ps5.id, { ids: [c.id, a.id, x.id] }, admin.req)),
        409,
        'un servicio de otro equipo no entra en este orden',
      );

      await catalog.orderEquipment(category.id, { ids: [sw.id, xbox.id, ps5.id] }, admin.req);
      await catalog.orderServices(ps5.id, { ids: [c.id, a.id, b.id] }, admin.req);

      const devices = (await catalog.adminEquipment(admin.req))
        .filter((e) => e.categoryId === category.id)
        .map((e) => e.id);
      assert.deepEqual(devices, [sw.id, xbox.id, ps5.id]);
      // Catálogo público y de administración: equipo (orden) → servicio (orden).
      const mine = (list: { id: string }[]) =>
        list.map((o) => o.id).filter((id) => [a.id, b.id, c.id, x.id].includes(id));
      assert.deepEqual(mine(await catalog.catalog()), [x.id, c.id, a.id, b.id]);
      assert.deepEqual(mine(await catalog.services(admin.req)), [x.id, c.id, a.id, b.id]);
      // Editar un servicio no cambia su lugar.
      await catalog.editService(
        a.id,
        { ...base, title: `Mantenimiento editado ${tag}`, equipmentId: ps5.id, priceMinor: 999 },
        admin.req,
      );
      assert.deepEqual(mine(await catalog.catalog()), [x.id, c.id, a.id, b.id]);
    } finally {
      const devices = await db.equipment.findMany({
        where: { categoryId: { in: [category.id, other.id] } },
        select: { id: true },
      });
      await db.offering.deleteMany({ where: { equipmentId: { in: devices.map((d) => d.id) } } });
      await db.equipment.deleteMany({ where: { id: { in: devices.map((d) => d.id) } } });
      await db.serviceCategory.deleteMany({ where: { id: { in: [category.id, other.id] } } });
      await db.adminAction.deleteMany({ where: { actorId: admin.user.id } });
      await db.user.deleteMany({ where: { id: { in: [admin.user.id, customer.user.id] } } });
    }
  },
);

test(
  'ubicación: el técnico asignado ve la exacta; en una solicitud pendiente, solo el sector',
  { skip: !enabled },
  async () => {
    const tech = await person('TECHNICIAN');
    const startsAt = new Date(Date.now() + 2 * 86400000);
    const visit = (data: Record<string, unknown>) =>
      db.appointment.create({
        data: {
          title: 'Revisión',
          device: 'Laptop',
          startsAt,
          endsAt: new Date(startsAt.getTime() + 3600000),
          address: 'Av. Interoceánica, Cumbayá',
          technician: '',
          contactName: 'Cliente Mapa',
          contactPhone: '+593990001111',
          locationLatitude: -0.2,
          locationLongitude: -78.43,
          locationArea: 'Cumbayá',
          locationSource: 'WHATSAPP',
          ...data,
        },
      });
    const pending = await visit({});
    const mine = await visit({
      status: 'CONFIRMED',
      assignedTechnicianId: tech.user.id,
      technician: tech.user.name,
    });
    try {
      const user = tech.user as unknown as StaffUser;
      const assigned = await staffAppointment(user, mine.id);
      assert.equal(assigned.locationLatitude, -0.2);
      assert.equal(assigned.locationLongitude, -78.43);
      assert.equal(assigned.address, 'Av. Interoceánica, Cumbayá');
      // Pendiente: el sector (el panel lo abre en el mapa), nunca coordenadas ni contacto.
      const claimable = (await pendingAppointments(user)).find((a) => a.id === pending.id)!;
      assert.equal(claimable.locationArea, 'Cumbayá');
      assert.equal(claimable.locationLatitude, null);
      assert.equal(claimable.address, '');
      assert.equal(claimable.contactPhone, '');
    } finally {
      await db.appointment.deleteMany({ where: { id: { in: [pending.id, mine.id] } } });
      await db.user.deleteMany({ where: { id: tech.user.id } });
    }
  },
);
