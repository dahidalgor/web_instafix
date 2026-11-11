import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Request } from 'express';
import { AccountController } from '../account/account.controller';
import { AnalyticsController } from '../analytics/analytics.controller';
import { AppointmentsController } from '../appointments/appointments.controller';
import { newToken, tokenHash } from '../auth/security';
import { EmailAdminController } from '../auth/email-admin.controller';
import { pageParams } from '../common/pagination';
import { db } from '../database/client';
import { StaffController } from '../staff/staff.controller';
import { WhatsAppAdminController } from '../whatsapp/admin.controller';

const enabled = process.env.INSTAFIX_INTEGRATION === '1';
const phone = () => `+59388${randomInt(1000000, 9999999)}`;
const DAY = 86400000;

test('páginas: valores raros se corrigen al rango permitido', () => {
  assert.deepEqual(pageParams('3', '20'), { page: 3, pageSize: 20 });
  assert.deepEqual(pageParams('-4', '100000'), { page: 1, pageSize: 100 });
  assert.deepEqual(pageParams('abc', undefined, 10), { page: 1, pageSize: 10 });
  assert.deepEqual(pageParams('99999999', '1'), { page: 10000, pageSize: 5 });
});

test(
  'listas largas por páginas: citas de administración, historial del técnico, Mi cuenta y Sistema',
  { skip: !enabled },
  async (t) => {
    const tag = `Paginar${randomInt(1e6)}`;
    const people: string[] = [];
    async function person(role: 'ADMIN' | 'TECHNICIAN' | 'CUSTOMER', name: string) {
      const user = await db.user.create({
        data: { name, phone: phone(), passwordHash: 'x', role, phoneVerifiedAt: new Date() },
      });
      people.push(user.id);
      const token = newToken();
      await db.session.create({
        data: {
          userId: user.id,
          tokenHash: tokenHash(token),
          expiresAt: new Date(Date.now() + 6e5),
        },
      });
      const req = {
        headers: { origin: 'http://localhost:5173', cookie: `instafix_session=${token}` },
      } as unknown as Request;
      return { user, req };
    }
    const admin = await person('ADMIN', `Admin ${tag}`);
    const tech = await person('TECHNICIAN', `Técnico ${tag}`);
    const customer = await person('CUSTOMER', `Cliente ${tag}`);
    t.after(async () => {
      await db.completedJob.deleteMany({ where: { userId: customer.user.id } });
      await db.appointment.deleteMany({ where: { title: { startsWith: tag } } });
      await db.user.deleteMany({ where: { id: { in: people } } });
    });

    // 25 visitas pasadas completadas del técnico y del cliente, 3 próximas confirmadas y 2
    // pendientes; una con nombre con tilde para la búsqueda.
    const make = (i: number, data: Record<string, unknown>) =>
      db.appointment.create({
        data: {
          title: `${tag} visita ${i}`,
          device: 'PS5',
          address: '',
          technician: '',
          contactName: i === 0 ? `Saúl ${tag}` : `Cliente ${tag}`,
          contactPhone: customer.user.phone,
          userId: customer.user.id,
          ...data,
        } as never,
      });
    const rows = [];
    for (let i = 0; i < 25; i++) {
      const startsAt = new Date(Date.now() - (i + 2) * DAY);
      rows.push(
        await make(i, {
          startsAt,
          endsAt: new Date(startsAt.getTime() + 3600000),
          status: 'COMPLETED',
          completedAt: startsAt,
          assignedTechnicianId: tech.user.id,
        }),
      );
    }
    for (let i = 0; i < 3; i++) {
      const startsAt = new Date(Date.now() + (i + 2) * DAY);
      rows.push(
        await make(100 + i, {
          startsAt,
          endsAt: new Date(startsAt.getTime() + 3600000),
          status: 'CONFIRMED',
          assignedTechnicianId: tech.user.id,
        }),
      );
    }
    for (let i = 0; i < 2; i++) {
      const startsAt = new Date(Date.now() + (i + 5) * DAY);
      rows.push(
        await make(200 + i, {
          startsAt,
          endsAt: new Date(startsAt.getTime() + 3600000),
          status: 'PENDING_LOCATION',
          source: 'INSTAFIX_API',
        }),
      );
    }

    // Administración: búsqueda (sin tildes), contadores por estado y páginas de 10.
    const admins = new AppointmentsController();
    const pageOf = (query: Record<string, string>) =>
      admins.adminAppointments(admin.req, { q: tag, ...query });
    const first = await pageOf({ status: 'all', pageSize: '10' });
    assert.equal(first.total, 30);
    assert.equal(first.items.length, 10);
    assert.deepEqual(
      { all: first.counts.all, active: first.counts.active, done: first.counts.COMPLETED },
      { all: 30, active: 5, done: 25 },
    );
    const third = await pageOf({ status: 'all', pageSize: '10', page: '3' });
    assert.equal(third.items.length, 10);
    assert.equal(
      new Set([...first.items, ...third.items].map((a) => a.id)).size,
      20,
      'sin repetir citas entre páginas',
    );
    // Activas por defecto, de la más próxima a la más lejana.
    const active = await pageOf({});
    assert.equal(active.total, 5);
    assert.ok(
      active.items.every(
        (a, i) => i === 0 || a.startsAt.getTime() >= active.items[i - 1].startsAt.getTime(),
      ),
    );
    assert.equal((await pageOf({ status: 'all', date: 'past' })).total, 25);
    assert.equal((await pageOf({ status: 'PENDING_LOCATION' })).total, 2);
    // «saul» encuentra a «Saúl»; el teléfono por sus dígitos.
    const saul = await admins.adminAppointments(admin.req, { status: 'all', q: `saul ${tag}` });
    assert.equal(saul.total, 1);
    const byPhone = await admins.adminAppointments(admin.req, {
      status: 'all',
      q: customer.user.phone.slice(-7),
    });
    assert.ok(byPhone.total >= 30);
    // Una cita concreta (enlace de un aviso) y las activas de un cliente (registrar trabajo).
    const one = await admins.adminAppointments(admin.req, { id: rows[0].id, status: 'all' });
    assert.deepEqual(
      one.items.map((a) => a.id),
      [rows[0].id],
    );
    const forJob = await admins.adminAppointments(admin.req, {
      userId: customer.user.id,
      status: 'active',
    });
    assert.equal(forJob.total, 5);
    await assert.rejects(admins.adminAppointments(admin.req, { pageSize: '5000' }));
    await assert.rejects(admins.adminAppointments(tech.req, {}));

    // Técnico: «Hoy/Próximas» solo con lo abierto; el historial de 20 en 20.
    const staff = new StaffController();
    const current = await staff.mine(tech.req);
    assert.equal(current.length, 3);
    const history1 = await staff.history(tech.req, '1', '20');
    const history2 = await staff.history(tech.req, '2', '20');
    assert.equal(history1.total, 25);
    assert.equal(history1.items.length, 20);
    assert.equal(history2.items.length, 5);
    assert.ok(
      new Date(history1.items[0].startsAt) > new Date(history1.items[19].startsAt),
      'la más reciente primero',
    );

    // Mi cuenta: próximas completas, historial de 10 en 10 y resumen calculado en el servidor.
    const account = new AccountController();
    const upcoming = await account.appointments(customer.req);
    assert.equal(upcoming.total, 5);
    const past = await account.appointments(customer.req, 'past', '2', '10');
    assert.equal(past.total, 25);
    assert.equal(past.items.length, 10);
    await db.completedJob.create({
      data: {
        userId: customer.user.id,
        title: 'Mantenimiento',
        device: 'PS5',
        completedAt: new Date(),
        warrantyEndsAt: new Date(Date.now() + 30 * DAY),
        warrantyTerms: '—',
        priceMinor: 2500,
      },
    });
    const summary = await account.summary(customer.req);
    assert.equal(summary.upcoming, 5);
    assert.equal(summary.activeWarranties, 1);
    const jobs = await account.jobs(customer.req, '1', '10');
    assert.equal(jobs.items.length, Math.min(10, jobs.total));

    // Sistema: WhatsApp y correo traen los 20 últimos; el resto, por páginas.
    const whatsapp = new WhatsAppAdminController({ accountStatus: async () => null } as never);
    const messages = await whatsapp.messages(admin.req, '1');
    assert.ok(messages.items.length <= 20);
    assert.equal(messages.pageSize, 20);
    const jobsPage = await whatsapp.jobs(admin.req, '1');
    assert.ok(jobsPage.items.length <= 20);
    const logs = await new EmailAdminController().logs(admin.req, '1');
    assert.ok(logs.items.length <= 20);
    await assert.rejects(whatsapp.messages(customer.req, '1'));

    // Estadísticas: sesiones únicas contadas sin traerlas todas.
    const sessionId = randomUUID();
    await db.pageVisit.createMany({
      data: [
        { id: randomUUID(), sessionId, page: 'inicio' },
        { id: randomUUID(), sessionId, page: 'servicios' },
      ],
    });
    const stats = await new AnalyticsController().summary(admin.req);
    assert.ok(stats.sessions >= 1);
    assert.ok(stats.visits >= 2);
    await db.pageVisit.deleteMany({ where: { sessionId } });
  },
);
