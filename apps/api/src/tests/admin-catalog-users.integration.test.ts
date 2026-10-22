import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Request } from 'express';
import { PeopleAdminController } from '../admin/people-admin.controller';
import { hashPassword, newToken, tokenHash } from '../auth/security';
import { authenticated } from '../auth/session';
import { CatalogController } from '../catalog/catalog.controller';
import { db } from '../database/client';

const enabled = process.env.INSTAFIX_INTEGRATION === '1';
type Role = 'ADMIN' | 'CUSTOMER' | 'TECHNICIAN';
const tag = randomUUID().slice(0, 8);

async function account(role: Role, name = `${role} ${tag}`) {
  const user = await db.user.create({
    data: {
      name,
      phone: `+59398${randomInt(1000000, 9999999)}`,
      email: `${role.toLowerCase()}-${randomUUID().slice(0, 8)}@prueba.ec`,
      passwordHash: await hashPassword('clave-muy-segura-1'),
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
    socket: { remoteAddress: `10.7.${randomInt(0, 255)}.${randomInt(1, 254)}` },
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
const appointment = (data: Record<string, unknown>) => {
  const startsAt = new Date(Date.now() + 3 * 86400000);
  return db.appointment.create({
    data: {
      title: 'Mantenimiento',
      device: 'PS5',
      startsAt,
      endsAt: new Date(startsAt.getTime() + 3600000),
      address: 'Quito',
      technician: '',
      contactName: 'Cliente Prueba',
      contactPhone: '+593990000000',
      ...data,
    },
  });
};

test(
  'Usuarios: filtro por rol y eliminación (borrado o anonimización)',
  { skip: !enabled },
  async () => {
    const people = new PeopleAdminController();
    const admin = await account('ADMIN');
    const tech = await account('TECHNICIAN');
    const fresh = await account('CUSTOMER');
    const withHistory = await account('CUSTOMER');
    const appointmentIds: string[] = [];
    try {
      // Filtro por rol: solo devuelve ese rol.
      const techs = await people.accounts(admin.req, tag, 'TECHNICIAN', '1', '50');
      assert.ok(techs.items.length >= 1);
      assert.ok(techs.items.every((u) => u.role === 'TECHNICIAN'));
      const customers = await people.accounts(admin.req, tag, 'CUSTOMER', '1', '50');
      assert.deepEqual(
        customers.items.map((u) => u.id).sort(),
        [fresh.user.id, withHistory.user.id].sort(),
      );
      // Un rol desconocido no filtra (y no falla).
      const all = await people.accounts(admin.req, tag, 'ROOT', '1', '50');
      assert.equal(all.total, 4);

      // Solo administración; nunca la propia cuenta.
      assert.equal(await status(people.removeAccount(fresh.user.id, tech.req)), 403);
      assert.equal(await status(people.removeAccount(admin.user.id, admin.req)), 400);

      // Técnico con visitas futuras asignadas: hay que reasignarlas primero.
      const assigned = await appointment({
        assignedTechnicianId: tech.user.id,
        technician: tech.user.name,
        status: 'CONFIRMED',
      });
      appointmentIds.push(assigned.id);
      assert.equal(await status(people.removeAccount(tech.user.id, admin.req)), 409);
      await db.appointment.update({
        where: { id: assigned.id },
        data: { assignedTechnicianId: null, status: 'PENDING_LOCATION' },
      });

      // Sin historial: la cuenta desaparece por completo (sesiones incluidas).
      const erased = await people.removeAccount(fresh.user.id, admin.req);
      assert.deepEqual(erased, { ok: true, anonymized: false });
      assert.equal(await db.user.findUnique({ where: { id: fresh.user.id } }), null);
      assert.equal(await db.session.count({ where: { userId: fresh.user.id } }), 0);
      assert.equal(await status(authenticated(fresh.req)), 401);

      // Con citas: se anonimiza, el historial se conserva y el teléfono queda libre.
      const booked = await appointment({
        userId: withHistory.user.id,
        contactPhone: withHistory.user.phone,
      });
      appointmentIds.push(booked.id);
      const anonymized = await people.removeAccount(withHistory.user.id, admin.req);
      assert.deepEqual(anonymized, { ok: true, anonymized: true });
      const ghost = await db.user.findUniqueOrThrow({ where: { id: withHistory.user.id } });
      assert.ok(ghost.deletedAt);
      assert.equal(ghost.active, false);
      assert.equal(ghost.email, null);
      assert.equal(ghost.name, 'Cuenta eliminada');
      assert.notEqual(ghost.phone, withHistory.user.phone);
      assert.notEqual(ghost.passwordHash, withHistory.user.passwordHash);
      assert.equal(await db.session.count({ where: { userId: ghost.id } }), 0);
      assert.equal(await status(authenticated(withHistory.req)), 401);
      assert.equal(await db.user.count({ where: { phone: withHistory.user.phone } }), 0);
      const kept = await db.appointment.findUniqueOrThrow({ where: { id: booked.id } });
      assert.equal(kept.userId, ghost.id);
      assert.equal(kept.contactPhone, withHistory.user.phone);
      // Ya no aparece en Usuarios ni se puede eliminar de nuevo.
      const after = await people.accounts(admin.req, tag, '', '1', '50');
      assert.ok(!after.items.some((u) => u.id === ghost.id || u.id === fresh.user.id));
      assert.equal(await status(people.removeAccount(ghost.id, admin.req)), 404);
      const audit = await db.adminAction.findMany({
        where: { action: 'USER_DELETED', target: { in: [fresh.user.id, ghost.id] } },
      });
      assert.equal(audit.length, 2);
      // La auditoría no guarda datos personales.
      assert.ok(audit.every((a) => !JSON.stringify(a.detail).includes('+593')));
    } finally {
      await db.appointment.deleteMany({ where: { id: { in: appointmentIds } } });
      await db.adminAction.deleteMany({ where: { actorId: admin.user.id } });
      await db.user.deleteMany({
        where: { id: { in: [admin.user.id, tech.user.id, fresh.user.id, withHistory.user.id] } },
      });
    }
  },
);

test(
  'Servicios: eliminar y equipos desactivados fuera de la página pública',
  { skip: !enabled },
  async () => {
    const catalog = new CatalogController();
    const admin = await account('ADMIN');
    const customer = await account('CUSTOMER');
    const category = await db.serviceCategory.create({ data: { name: `Cat ${tag}` } });
    const device = await db.equipment.create({
      data: { name: `Equipo ${tag}`, categoryId: category.id },
    });
    const base = {
      equipmentId: device.id,
      description: 'Servicio de prueba completo',
      priceMinor: 2500,
      durationMinutes: 60,
      warrantyDays: 30,
      availability: 'AVAILABLE',
      media: [],
    };
    const unused = await catalog.addService({ ...base, title: `Limpieza ${tag}` }, admin.req);
    const used = await catalog.addService({ ...base, title: `Pantalla ${tag}` }, admin.req);
    const booked = await appointment({ offeringId: used.id });
    try {
      // Equipo desactivado: sus servicios dejan de publicarse; administración sí lo ve.
      assert.equal(
        await status(catalog.editEquipment(device.id, { active: false }, customer.req)),
        403,
      );
      await catalog.editEquipment(device.id, { active: false }, admin.req);
      const published = await catalog.catalog();
      assert.ok(!published.some((o) => o.equipmentId === device.id));
      assert.ok(!(await catalog.equipment()).some((e) => e.id === device.id));
      const adminDevices = await catalog.adminEquipment(admin.req);
      assert.equal(adminDevices.find((e) => e.id === device.id)?.active, false);
      assert.equal(await status(catalog.adminEquipment(customer.req)), 403);
      assert.ok((await catalog.services(admin.req)).some((o) => o.id === unused.id));
      await catalog.editEquipment(device.id, { active: true }, admin.req);
      assert.ok((await catalog.catalog()).some((o) => o.id === unused.id));

      // Eliminar: sin historial se borra; con historial se retira y la cita lo conserva.
      assert.equal(await status(catalog.removeService(unused.id, customer.req)), 403);
      assert.deepEqual(await catalog.removeService(unused.id, admin.req), {
        ok: true,
        kept: false,
      });
      assert.equal(await db.offering.findUnique({ where: { id: unused.id } }), null);
      assert.deepEqual(await catalog.removeService(used.id, admin.req), { ok: true, kept: true });
      assert.equal((await db.offering.findUniqueOrThrow({ where: { id: used.id } })).active, false);
      assert.equal(
        (await db.appointment.findUniqueOrThrow({ where: { id: booked.id } })).offeringId,
        used.id,
      );
      assert.ok(!(await catalog.services(admin.req)).some((o) => o.id === used.id));
      assert.ok(!(await catalog.catalog()).some((o) => o.id === used.id));
      // Un servicio eliminado no se edita ni se elimina otra vez.
      assert.equal(
        await status(catalog.editService(used.id, { ...base, title: 'Otra' }, admin.req)),
        404,
      );
      assert.equal(await status(catalog.removeService(used.id, admin.req)), 404);
    } finally {
      await db.appointment.deleteMany({ where: { id: booked.id } });
      await db.offering.deleteMany({ where: { equipmentId: device.id } });
      await db.equipment.deleteMany({ where: { id: device.id } });
      await db.serviceCategory.deleteMany({ where: { id: category.id } });
      await db.adminAction.deleteMany({ where: { actorId: admin.user.id } });
      await db.user.deleteMany({ where: { id: { in: [admin.user.id, customer.user.id] } } });
    }
  },
);
