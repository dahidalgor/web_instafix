import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Request } from 'express';
import { AppointmentsController, appointmentOrder } from '../appointments/appointments.controller';
import { hashPassword, newToken, tokenHash } from '../auth/security';
import { db } from '../database/client';
import { TeamController } from '../staff/team.controller';

const enabled = process.env.INSTAFIX_INTEGRATION === '1';
const phone = () => `+59399${randomInt(1000000, 9999999)}`;
async function userWithSession(role: 'ADMIN' | 'TECHNICIAN' | 'CUSTOMER', extra = {}) {
  const user = await db.user.create({
    data: {
      name: `${role} Prueba`,
      firstName: role,
      lastName: 'Prueba',
      phone: phone(),
      passwordHash: await hashPassword('clave-muy-segura-1'),
      role,
      phoneVerifiedAt: new Date(),
      ...extra,
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
  const req = {
    headers: { origin: 'http://localhost:5173', cookie: `instafix_session=${token}` },
  } as unknown as Request;
  return { user, req };
}

test('sort options map to real columns with a stable tie-breaker', () => {
  assert.deepEqual(appointmentOrder('created_desc'), [{ createdAt: 'desc' }, { id: 'asc' }]);
  assert.deepEqual(appointmentOrder('starts_asc'), [{ startsAt: 'asc' }, { id: 'asc' }]);
});

test(
  'admin appointment list is ordered by createdAt or startsAt in the database',
  { skip: !enabled },
  async () => {
    const { user: admin, req } = await userWithSession('ADMIN');
    const tag = `sort-${randomUUID()}`;
    const day = 86400000;
    // Creada antes pero con visita más lejana, y al revés: los dos órdenes deben diferir.
    const a = await db.appointment.create({
      data: {
        title: tag,
        device: 'x',
        address: '',
        technician: '',
        startsAt: new Date(Date.now() + 9 * day),
        endsAt: new Date(Date.now() + 9 * day + 3600000),
        createdAt: new Date(Date.now() - 2 * day),
      },
    });
    const b = await db.appointment.create({
      data: {
        title: tag,
        device: 'x',
        address: '',
        technician: '',
        startsAt: new Date(Date.now() + 2 * day),
        endsAt: new Date(Date.now() + 2 * day + 3600000),
        createdAt: new Date(Date.now() - day),
      },
    });
    const controller = new AppointmentsController();
    const ids = async (sort?: string) =>
      (await controller.adminAppointments(req, sort))
        .filter((x) => x.title === tag)
        .map((x) => x.id);
    try {
      assert.deepEqual(await ids('created_desc'), [b.id, a.id]);
      assert.deepEqual(await ids('created_asc'), [a.id, b.id]);
      assert.deepEqual(await ids('starts_asc'), [b.id, a.id]);
      assert.deepEqual(await ids('starts_desc'), [a.id, b.id]);
      assert.deepEqual(await ids(), [a.id, b.id]); // por defecto: como antes, por fecha de la cita
      await assert.rejects(
        controller.adminAppointments(req, 'title; DROP TABLE'),
        /Orden no válido/,
      );
    } finally {
      await db.appointment.deleteMany({ where: { title: tag } });
      await db.user.delete({ where: { id: admin.id } });
    }
  },
);

test(
  'technician editing: admin only, safe fields, unique phone, upcoming visits kept on deactivation',
  { skip: !enabled },
  async () => {
    const admin = await userWithSession('ADMIN');
    const tech = await userWithSession('TECHNICIAN');
    const other = await userWithSession('TECHNICIAN');
    const customer = await userWithSession('CUSTOMER');
    const team = new TeamController();
    const tag = `team-${randomUUID()}`;
    try {
      // Permisos verificados en el backend, no solo ocultando botones.
      await assert.rejects(
        team.update(tech.user.id, { firstName: 'Hack' }, customer.req),
        (e: any) => e.getStatus() === 403,
      );
      await assert.rejects(
        team.update(other.user.id, { firstName: 'Hack' }, tech.req),
        (e: any) => e.getStatus() === 403,
      );
      // Campos internos rechazados por el esquema estricto.
      await assert.rejects(
        team.update(tech.user.id, { role: 'ADMIN' }, admin.req),
        (e: any) => e.getStatus() === 400,
      );
      await assert.rejects(
        team.update(tech.user.id, { passwordHash: 'x' }, admin.req),
        (e: any) => e.getStatus() === 400,
      );
      // Ni clientes ni administradores se editan desde aquí.
      await assert.rejects(
        team.update(customer.user.id, { firstName: 'Otro' }, admin.req),
        (e: any) => e.getStatus() === 404,
      );
      await assert.rejects(
        team.update(admin.user.id, { firstName: 'Otro' }, admin.req),
        (e: any) => e.getStatus() === 404,
      );

      const visit = await db.appointment.create({
        data: {
          title: tag,
          device: 'x',
          address: '',
          technician: tech.user.name,
          assignedTechnicianId: tech.user.id,
          status: 'CONFIRMED',
          startsAt: new Date(Date.now() + 86400000),
          endsAt: new Date(Date.now() + 90000000),
        },
      });
      const past = await db.appointment.create({
        data: {
          title: tag,
          device: 'x',
          address: '',
          technician: tech.user.name,
          assignedTechnicianId: tech.user.id,
          status: 'COMPLETED',
          startsAt: new Date(Date.now() - 86400000),
          endsAt: new Date(Date.now() - 80000000),
        },
      });
      const newPhone = phone();
      const updated = await team.update(
        tech.user.id,
        {
          firstName: 'carla',
          lastName: 'pérez',
          phone: '0' + newPhone.slice(4),
          email: 'Carla@Example.com',
        },
        admin.req,
      );
      assert.equal(updated.name, 'Carla Pérez');
      assert.equal(updated.phone, newPhone);
      assert.equal(updated.email, 'carla@example.com');
      // La visita futura muestra el nuevo nombre; el historial conserva el anterior.
      assert.equal(
        (await db.appointment.findUniqueOrThrow({ where: { id: visit.id } })).technician,
        'Carla Pérez',
      );
      assert.equal(
        (await db.appointment.findUniqueOrThrow({ where: { id: past.id } })).technician,
        tech.user.name,
      );
      assert.equal(await db.session.count({ where: { userId: tech.user.id } }), 0); // cambió su teléfono de acceso
      // Teléfono de otra cuenta: conflicto, sin cambios.
      await assert.rejects(
        team.update(tech.user.id, { phone: other.user.phone }, admin.req),
        (e: any) => e.getStatus() === 409,
      );

      // Desactivar con citas futuras exige confirmación y no modifica las citas.
      const denied = await team.update(tech.user.id, { active: false }, admin.req).catch((e) => e);
      assert.equal(denied.getResponse().code, 'TECHNICIAN_HAS_UPCOMING');
      assert.equal((await db.user.findUniqueOrThrow({ where: { id: tech.user.id } })).active, true);
      await team.update(
        tech.user.id,
        { active: false, confirmFutureAppointments: true },
        admin.req,
      );
      assert.equal(
        (await db.user.findUniqueOrThrow({ where: { id: tech.user.id } })).active,
        false,
      );
      const kept = await db.appointment.findUniqueOrThrow({ where: { id: visit.id } });
      assert.equal(kept.assignedTechnicianId, tech.user.id);
      assert.equal(kept.status, 'CONFIRMED');
      const listed = (await team.list(admin.req)).find((m) => m.id === tech.user.id)!;
      assert.equal(listed.upcomingAppointments, 1);
    } finally {
      await db.appointment.deleteMany({ where: { title: tag } });
      await db.user.deleteMany({
        where: { id: { in: [admin.user.id, tech.user.id, other.user.id, customer.user.id] } },
      });
    }
  },
);
