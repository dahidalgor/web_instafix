import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Request } from 'express';
import { AccountController } from '../account/account.controller';
import { AppointmentsController } from '../appointments/appointments.controller';
import { newToken, tokenHash } from '../auth/security';
import { CatalogController } from '../catalog/catalog.controller';
import { db } from '../database/client';
import { setEmailProvider } from '../mail/email.service';
import { NotificationWorker } from '../notifications/notification.service';
import { CAL_SYNC_ISSUE } from '../staff/staff-appointments.service';
import { StaffController } from '../staff/staff.controller';
import { TeamController } from '../staff/team.controller';

const enabled = process.env.INSTAFIX_INTEGRATION === '1';
Object.assign(process.env, {
  CAL_API_KEY: 'test-key',
  CAL_API_VERSION: '2026-02-25',
  APPOINTMENT_EMAILS_ENABLED: 'true',
  SMTP_HOST: process.env.SMTP_HOST || 'smtp-relay.brevo.com',
  SMTP_FROM: process.env.SMTP_FROM || 'Instafix <test@instafix.ec>',
  SMTP_USER: process.env.SMTP_USER || 'test',
  SMTP_PASSWORD: process.env.SMTP_PASSWORD || 'test',
  WHATSAPP_TEMPLATE_CONFIRMED: 'instafix_cita_confirmada',
});
const emails: { to: string; subject: string; text: string }[] = [];
setEmailProvider({
  name: 'TEST',
  async send(to, message) {
    emails.push({ to, subject: message.subject, text: message.text });
    return { messageId: `<${randomUUID()}@brevo>` };
  },
});

// Cal.com simulado: la reserva está «pending» hasta que Instafix la confirma.
const calCalls: { url: string; method: string }[] = [];
let calFails = false;
const calStatus = new Map<string, string>();
const original = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: RequestInit) => {
  const url = String(input);
  if (!url.startsWith('https://api.cal.com/')) return original(input, init);
  const method = init?.method || 'GET';
  calCalls.push({ url, method });
  if (calFails) return Response.json({}, { status: 503 });
  const uid = decodeURIComponent(url.split('/bookings/')[1]?.split('/')[0] || '');
  if (method === 'POST' && url.endsWith('/confirm')) {
    calStatus.set(uid, 'accepted');
    return Response.json({ status: 'success', data: { uid } });
  }
  return Response.json({
    status: 'success',
    data: { uid, status: calStatus.get(uid) || 'pending' },
  });
}) as typeof fetch;

const phone = () => `+59398${String(randomInt(1000000, 9999999))}`;
const req = (token = '') =>
  ({
    headers: { origin: 'http://localhost:5173', cookie: token ? `instafix_session=${token}` : '' },
  }) as unknown as Request;
const status = (error: any) => (typeof error?.getStatus === 'function' ? error.getStatus() : 0);

async function member(role: 'ADMIN' | 'TECHNICIAN' | 'CUSTOMER', name: string, email?: string) {
  const user = await db.user.create({
    data: {
      name,
      phone: phone(),
      email: email ?? null,
      passwordHash: 'sin-login',
      phoneVerifiedAt: new Date(),
      role,
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
  return { user, token };
}

async function pendingAppointment(
  owner: { id: string; email: string | null } | null,
  calUid?: string,
) {
  const startsAt = new Date(Date.now() + 2 * 86400000);
  return db.appointment.create({
    data: {
      userId: owner?.id ?? null,
      contactName: 'David Hidalgo',
      contactPhone: phone(),
      contactEmail: owner?.email ?? `guest-${randomUUID()}@example.com`,
      whatsappConsentAt: new Date(),
      title: 'Mi PS5 se apaga después de jugar 20 minutos.',
      device: 'Por especificar',
      startsAt,
      endsAt: new Date(startsAt.getTime() + 3600000),
      address: '',
      technician: '',
      calUid: calUid ?? null,
      calStatus: calUid ? 'pending' : null,
      source: 'INSTAFIX_API',
    },
  });
}

test(
  'roles: technicians reach their panel, never the admin; customers reach neither',
  { skip: !enabled },
  async () => {
    const staff = new StaffController();
    const appointments = new AppointmentsController();
    const team = new TeamController();
    const catalog = new CatalogController();
    const tech = await member('TECHNICIAN', 'Técnico Roles');
    const customer = await member('CUSTOMER', 'Cliente Roles');
    const admin = await member('ADMIN', 'Admin Roles');
    try {
      assert.ok(Array.isArray(await staff.mine(req(tech.token))));
      assert.ok(Array.isArray(await staff.pending(req(tech.token))));
      assert.ok(Array.isArray(await staff.mine(req(admin.token))));
      // Endpoints administrativos prohibidos para el técnico.
      for (const call of [
        () => appointments.adminAppointments(req(tech.token)),
        () => team.list(req(tech.token)),
        () => catalog.services(req(tech.token)),
        () => team.create({}, req(tech.token)),
      ])
        await assert.rejects(call(), (e) => status(e) === 403);
      // El cliente no entra al panel técnico.
      await assert.rejects(staff.pending(req(customer.token)), (e) => status(e) === 403);
      await assert.rejects(staff.mine(req()), (e) => status(e) === 401);
      // Desactivar a un técnico corta su sesión.
      await team.update(tech.user.id, { active: false }, req(admin.token));
      await assert.rejects(staff.mine(req(tech.token)), (e) => status(e) === 401);
      // El panel de equipo no gestiona administradores ni la propia cuenta.
      await assert.rejects(
        team.update(admin.user.id, { active: false }, req(admin.token)),
        (e) => status(e) === 404,
      );
    } finally {
      await db.user.deleteMany({
        where: { id: { in: [tech.user.id, customer.user.id, admin.user.id] } },
      });
    }
  },
);

test(
  'admin creates a technician with a secure password; duplicates are rejected',
  { skip: !enabled },
  async () => {
    const team = new TeamController();
    const admin = await member('ADMIN', 'Admin Equipo');
    const techPhone = phone();
    try {
      await assert.rejects(
        team.create(
          { firstName: 'An', lastName: 'Tony', phone: techPhone, password: 'corta' },
          req(admin.token),
        ),
        (e) => status(e) === 400,
      );
      const created = await team.create(
        {
          firstName: 'anthony',
          lastName: 'pérez',
          phone: techPhone,
          password: 'clave-muy-segura-12',
        },
        req(admin.token),
      );
      assert.equal(created.role, 'TECHNICIAN');
      assert.equal(created.name, 'Anthony Pérez');
      const stored = await db.user.findUniqueOrThrow({ where: { id: created.id } });
      assert.notEqual(stored.passwordHash, 'clave-muy-segura-12');
      assert.match(stored.passwordHash, /^[a-f0-9]{32}:[a-f0-9]{128}$/);
      await assert.rejects(
        team.create(
          {
            firstName: 'Otro',
            lastName: 'Técnico',
            phone: techPhone,
            password: 'clave-muy-segura-12',
          },
          req(admin.token),
        ),
        (e) => status(e) === 409,
      );
    } finally {
      await db.user.deleteMany({ where: { OR: [{ id: admin.user.id }, { phone: techPhone }] } });
    }
  },
);

test(
  'confirm = self-assign: pending → confirmed, one email, Cal synced, visible to the customer',
  { skip: !enabled },
  async () => {
    const staff = new StaffController();
    const account = new AccountController();
    const anthony = await member('TECHNICIAN', 'Anthony');
    const other = await member('TECHNICIAN', 'Técnico B');
    const customer = await member('CUSTOMER', 'David Hidalgo', `david-${randomUUID()}@example.com`);
    const uid = `cal-${randomUUID()}`;
    const appointment = await pendingAppointment(customer.user, uid);
    try {
      // Aparece en pendientes para ambos técnicos, sin teléfono hasta asignarse.
      const pendingA = (await staff.pending(req(anthony.token))).find(
        (a) => a.id === appointment.id,
      );
      assert.ok(pendingA);
      assert.equal(pendingA.contactPhone, '');
      assert.equal(pendingA.canManage, false);

      const result = await staff.confirm(appointment.id, req(anthony.token));
      assert.equal(result.appointment.status, 'CONFIRMED');
      assert.equal(result.appointment.assignedTechnician?.name, 'Anthony');
      assert.equal(result.cal, 'SYNCED');
      assert.ok(calCalls.some((c) => c.url.endsWith(`/bookings/${uid}/confirm`)));

      const stored = await db.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
      assert.equal(stored.assignedTechnicianId, anthony.user.id);
      assert.equal(stored.confirmedById, anthony.user.id);
      assert.ok(stored.confirmedAt);
      assert.equal(stored.calStatus, 'accepted');
      assert.equal(stored.technician, 'Anthony');

      // Desaparece de pendientes y aparece en «Mis citas» de Anthony, no en las del otro.
      assert.equal(
        (await staff.pending(req(other.token))).some((a) => a.id === appointment.id),
        false,
      );
      assert.equal(
        (await staff.mine(req(anthony.token))).some((a) => a.id === appointment.id),
        true,
      );
      assert.equal(
        (await staff.mine(req(other.token))).some((a) => a.id === appointment.id),
        false,
      );
      await assert.rejects(
        staff.detail(appointment.id, req(other.token)),
        (e) => status(e) === 404,
      );

      // Repetir la confirmación es idempotente: ni otro correo ni otro WhatsApp.
      const again = await staff.confirm(appointment.id, req(anthony.token));
      assert.equal(again.alreadyConfirmed, true);
      const confirmEmails = emails.filter(
        (e) => e.to === customer.user.email && /visita está confirmada/.test(e.subject),
      );
      assert.equal(confirmEmails.length, 1);
      assert.match(confirmEmails[0].text, /Anthony/);
      assert.match(confirmEmails[0].text, /Mi PS5 se apaga/);
      assert.equal(
        await db.automationJob.count({
          where: { appointmentId: appointment.id, kind: 'CONFIRMED' },
        }),
        1,
      );
      // El cliente ve a su técnico, nunca las notas internas.
      const mine = (await account.appointments(req(customer.token))).find(
        (a) => a.id === appointment.id,
      )!;
      assert.equal(mine.assignedTechnician?.name, 'Anthony');
      assert.equal('technicianNotes' in mine, false);
      // Un segundo técnico no puede quitársela.
      await assert.rejects(
        staff.confirm(appointment.id, req(other.token)),
        (e) => status(e) === 409,
      );
    } finally {
      await db.appointment.deleteMany({ where: { id: appointment.id } });
      await db.user.deleteMany({
        where: { id: { in: [anthony.user.id, other.user.id, customer.user.id] } },
      });
    }
  },
);

test(
  'concurrency: two technicians confirm at once, exactly one wins and one email is queued',
  { skip: !enabled },
  async () => {
    const staff = new StaffController();
    const a = await member('TECHNICIAN', 'Anthony Carrera');
    const b = await member('TECHNICIAN', 'Técnico Carrera');
    const appointment = await pendingAppointment(null);
    try {
      const results = await Promise.allSettled([
        staff.confirm(appointment.id, req(a.token)),
        staff.confirm(appointment.id, req(b.token)),
        staff.confirm(appointment.id, req(b.token)),
      ]);
      const won = results.filter((r) => r.status === 'fulfilled');
      const lost = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      const stored = await db.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
      assert.ok(stored.assignedTechnicianId);
      // Quien ganó puede repetir la llamada (idempotente); el otro recibe el aviso claro.
      for (const r of lost) {
        assert.equal(status(r.reason), 409);
        assert.equal(r.reason.message, 'Esta cita acaba de ser confirmada por otro técnico.');
      }
      assert.ok(won.length >= 1);
      assert.ok(lost.length >= 1);
      for (const r of won)
        assert.equal(
          (r as PromiseFulfilledResult<any>).value.appointment.assignedTechnician.id,
          stored.assignedTechnicianId,
        );
      assert.equal(
        await db.notification.count({
          where: { appointmentId: appointment.id, kind: 'APPOINTMENT_CONFIRMED' },
        }),
        1,
      );
      assert.equal(
        await db.appointmentActivity.count({
          where: { appointmentId: appointment.id, action: 'CONFIRMED' },
        }),
        1,
      );
    } finally {
      await db.appointment.deleteMany({ where: { id: appointment.id } });
      await db.user.deleteMany({ where: { id: { in: [a.user.id, b.user.id] } } });
    }
  },
);

test(
  'services performed: catalog snapshot, quantities, request preserved, complete once',
  { skip: !enabled },
  async () => {
    const staff = new StaffController();
    const account = new AccountController();
    const tech = await member('TECHNICIAN', 'Anthony Servicios');
    const other = await member('TECHNICIAN', 'Otro Servicios');
    const customer = await member(
      'CUSTOMER',
      'Cliente Servicios',
      `svc-${randomUUID()}@example.com`,
    );
    const equipment = await db.equipment.create({
      data: { name: `PS5-${randomUUID()}`, category: 'Consolas' },
    });
    const maintenance = await db.offering.create({
      data: {
        id: randomUUID(),
        category: 'Consolas',
        device: equipment.name,
        title: 'Mantenimiento PS5',
        priceMinor: 2500,
        durationMinutes: 60,
        equipmentId: equipment.id,
        warrantyDays: 30,
      },
    });
    const metal = await db.offering.create({
      data: {
        id: randomUUID(),
        category: 'Consolas',
        device: equipment.name,
        title: 'Cambio de metal líquido',
        priceMinor: 4000,
        durationMinutes: 60,
        equipmentId: equipment.id,
      },
    });
    const appointment = await pendingAppointment(customer.user);
    try {
      // Sin confirmar no se registran trabajos.
      await assert.rejects(
        staff.add(appointment.id, { offeringId: maintenance.id, quantity: 1 }, req(tech.token)),
        (e) => status(e) === 404 || status(e) === 403 || status(e) === 400,
      );
      await staff.confirm(appointment.id, req(tech.token));
      await staff.add(appointment.id, { offeringId: maintenance.id }, req(tech.token));
      let detail = await staff.add(
        appointment.id,
        { offeringId: metal.id, quantity: 2 },
        req(tech.token),
      );
      // Duplicado accidental rechazado; la cantidad se ajusta aparte.
      await assert.rejects(
        staff.add(appointment.id, { offeringId: metal.id, quantity: 1 }, req(tech.token)),
        (e) => status(e) === 409,
      );
      const metalItem = detail.services.find((s) => s.offeringId === metal.id)!;
      assert.equal(metalItem.totalMinor, 8000);
      detail = await staff.update(appointment.id, metalItem.id, { quantity: 1 }, req(tech.token));
      assert.equal(detail.services.find((s) => s.id === metalItem.id)!.totalMinor, 4000);
      await assert.rejects(
        staff.update(appointment.id, metalItem.id, { quantity: 0 }, req(tech.token)),
        (e) => status(e) === 400,
      );
      // Otro técnico no puede tocar la visita.
      await assert.rejects(
        staff.add(appointment.id, { offeringId: maintenance.id }, req(other.token)),
        (e) => status(e) === 403,
      );
      await staff.notes(
        appointment.id,
        { notes: 'Polvo severo y metal líquido desplazado.' },
        req(tech.token),
      );
      // El precio del catálogo cambia después: la visita conserva el aplicado.
      await db.offering.update({ where: { id: maintenance.id }, data: { priceMinor: 9900 } });

      const done = await staff.complete(appointment.id, req(tech.token));
      assert.equal(done.appointment.status, 'COMPLETED');
      assert.equal((await staff.complete(appointment.id, req(tech.token))).alreadyCompleted, true);
      await assert.rejects(
        staff.add(appointment.id, { offeringId: maintenance.id }, req(tech.token)),
        (e) => status(e) === 400,
      );
      const stored = await db.appointment.findUniqueOrThrow({
        where: { id: appointment.id },
        include: { services: true },
      });
      assert.equal(stored.title, 'Mi PS5 se apaga después de jugar 20 minutos.');
      assert.equal(stored.completedById, tech.user.id);
      assert.ok(stored.completedAt);
      assert.deepEqual(
        stored.services.map((s) => [s.nameSnapshot, s.unitPriceMinor, s.quantity]).sort(),
        [
          ['Cambio de metal líquido', 4000, 1],
          ['Mantenimiento PS5', 2500, 1],
        ],
      );
      assert.equal(
        stored.services.find((s) => s.offeringId === maintenance.id)!.warrantyDaysSnapshot,
        30,
      );
      // Historial del cliente: solicitud original + servicios + técnico, sin notas internas.
      const history = (await account.appointments(req(customer.token))).find(
        (a) => a.id === appointment.id,
      )!;
      assert.equal(history.title, 'Mi PS5 se apaga después de jugar 20 minutos.');
      assert.equal(history.services.length, 2);
      assert.equal(history.assignedTechnician?.name, 'Anthony Servicios');
      assert.equal(JSON.stringify(history).includes('Polvo severo'), false);
      assert.ok(
        (await db.appointmentActivity.count({ where: { appointmentId: appointment.id } })) >= 6,
      );
    } finally {
      await db.appointment.deleteMany({ where: { id: appointment.id } });
      await db.offering.deleteMany({ where: { id: { in: [maintenance.id, metal.id] } } });
      await db.equipment.delete({ where: { id: equipment.id } });
      await db.user.deleteMany({
        where: { id: { in: [tech.user.id, other.user.id, customer.user.id] } },
      });
    }
  },
);

test(
  'Cal.com down: the visit stays confirmed in Instafix and the worker syncs it later',
  { skip: !enabled },
  async () => {
    const staff = new StaffController();
    const tech = await member('TECHNICIAN', 'Técnico Cal');
    const uid = `cal-${randomUUID()}`;
    const appointment = await pendingAppointment(null, uid);
    try {
      calFails = true;
      const result = await staff.confirm(appointment.id, req(tech.token));
      assert.equal(result.cal, 'PENDING');
      assert.equal(result.appointment.status, 'CONFIRMED');
      assert.equal(result.appointment.automationIssue, CAL_SYNC_ISSUE);
      calFails = false;
      await db.appointment.update({
        where: { id: appointment.id },
        data: { updatedAt: new Date(Date.now() - 600000) },
      });
      await db.$executeRaw`UPDATE "Appointment" SET "updatedAt" = now() - interval '10 minutes' WHERE id = ${appointment.id}`;
      await new NotificationWorker().tick();
      const stored = await db.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
      assert.equal(stored.calStatus, 'accepted');
      assert.equal(stored.automationIssue, null);
    } finally {
      calFails = false;
      await db.appointment.deleteMany({ where: { id: appointment.id } });
      await db.user.deleteMany({ where: { id: tech.user.id } });
    }
  },
);
