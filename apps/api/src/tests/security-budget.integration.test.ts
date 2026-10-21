import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Request } from 'express';
import { PeopleAdminController } from '../admin/people-admin.controller';
import { AppointmentsController } from '../appointments/appointments.controller';
import { AuthController } from '../auth/auth.controller';
import { newToken, tokenHash } from '../auth/security';
import type { StaffUser } from '../auth/session';
import { VerificationService } from '../auth/verification.service';
import { BookingController } from '../booking/booking.controller';
import { MAX_RESCHEDULES } from '../booking/booking.service';
import { db } from '../database/client';
import { setEmailProvider } from '../mail/email.service';
import { clientIp, clientSessionKey } from '../security/client-identity';
import { confirmAppointment } from '../staff/staff-appointments.service';
import { WHATSAPP_BUDGET } from '../whatsapp/budget';
import type { WhatsAppOtpProvider } from '../whatsapp/otp.provider';
import { processJob } from '../whatsapp/worker';

const enabled = process.env.INSTAFIX_INTEGRATION === '1';
Object.assign(process.env, {
  CAL_API_KEY: 'test-key',
  CAL_API_VERSION: '2026-02-25',
  CAL_EVENT_TYPE_ID: '424250',
  CAL_ATTENDEE_RELAY_EMAIL: 'reservas@instafix.ec',
  APPOINTMENT_EMAILS_ENABLED: 'false',
  BOOKING_MIN_DAYS_AHEAD: '1',
});
setEmailProvider({ name: 'TEST', send: async () => ({ messageId: null }) });

const testPhone = () => `+59397${String(randomInt(1000000, 9999999))}`;
const future = (days: number, hourUtc = 15) => {
  const d = new Date(Date.now() + days * 86400000);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d;
};
const req = (cookie = '', headers: Record<string, string> = {}) =>
  ({
    headers: { origin: 'http://localhost:5173', cookie, ...headers },
    socket: { remoteAddress: `10.9.${randomInt(0, 255)}.${randomInt(1, 254)}` },
  }) as unknown as Request;

// Cal.com simulado: cada reserva o reprogramación devuelve un uid nuevo.
const calls: { url: string; method: string }[] = [];
const original = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: RequestInit) => {
  const url = String(input);
  if (!url.startsWith('https://api.cal.com/')) return original(input, init);
  calls.push({ url, method: init?.method || 'GET' });
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  const booking = (start: string) =>
    Response.json({
      status: 'success',
      data: {
        uid: `sec-${randomUUID()}`,
        status: 'pending',
        start,
        end: new Date(new Date(start).getTime() + 3600000).toISOString(),
      },
    });
  if (url.endsWith('/bookings') && init?.method === 'POST') return booking(body.start);
  if (url.endsWith('/reschedule')) return booking(body.start);
  if (url.endsWith('/cancel') || url.endsWith('/confirm'))
    return Response.json({ status: 'success', data: {} });
  return Response.json({}, { status: 404 });
}) as typeof fetch;

/** «Bird» simulado: cuenta las llamadas reales al proveedor. */
let birdCalls = 0;
const providers = {
  send: async () => ({ providerMessageId: `sec-bird-${randomUUID()}`, provider: 'BIRD' }),
  confirm: async () => {},
};
const countingProviders = {
  ...providers,
  send: async () => {
    birdCalls++;
    return providers.send();
  },
};
async function runJobs(appointmentId: string) {
  const due = await db.automationJob.findMany({
    where: { appointmentId, status: { in: ['PENDING', 'RETRY'] }, dueAt: { lte: new Date() } },
  });
  for (const job of due) await processJob(job.id, countingProviders);
}
const jobs = (appointmentId: string) =>
  db.automationJob.findMany({ where: { appointmentId }, orderBy: { createdAt: 'asc' } });

async function customer(role: 'CUSTOMER' | 'ADMIN' | 'TECHNICIAN' = 'CUSTOMER') {
  const user = await db.user.create({
    data: {
      name: `Prueba ${role}`,
      phone: testPhone(),
      passwordHash: 'x',
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
  const cookie = `instafix_session=${token}`;
  return { user, cookie, sessionKey: clientSessionKey(req(cookie))! };
}
/** Simula que la sesión ya gastó su presupuesto de WhatsApp en otras citas. */
async function exhaustSessionBudget(sessionKey: string) {
  const other = await db.appointment.create({
    data: {
      contactName: 'Gasto previo',
      contactPhone: testPhone(),
      title: 'Previa',
      device: 'X',
      startsAt: future(9),
      endsAt: new Date(future(9).getTime() + 3600000),
      address: '',
      technician: '',
      source: 'INSTAFIX_API',
    },
  });
  for (let i = 0; i < WHATSAPP_BUDGET.perSession; i++)
    await db.automationJob.create({
      data: {
        dedupeKey: `${other.id}:spent:${i}`,
        appointmentId: other.id,
        revision: 0,
        kind: 'CONFIRMED',
        status: 'SENT',
        dueAt: new Date(),
        expiresAt: other.startsAt,
        startedAt: new Date(),
        originSessionKey: sessionKey,
      },
    });
  return other.id;
}

const cleanup: (() => Promise<unknown>)[] = [];
test.after(async () => {
  for (const step of cleanup.reverse()) await step().catch(() => {});
  globalThis.fetch = original;
});
const trackUser = (id: string) =>
  cleanup.push(async () => {
    await db.appointment.deleteMany({ where: { userId: id } });
    await db.user.delete({ where: { id } });
  });

test(
  'CRITICAL: with the WhatsApp budget exhausted the customer can still cancel; Bird is not called',
  { skip: !enabled },
  async () => {
    const controller = new BookingController();
    const { user, cookie, sessionKey } = await customer();
    trackUser(user.id);
    const spentOn = await exhaustSessionBudget(sessionKey);
    cleanup.push(() => db.appointment.delete({ where: { id: spentOn } }));
    birdCalls = 0;
    const created = await controller.create(
      { start: future(3).toISOString(), request: 'Mantenimiento de laptop', whatsappConsent: true },
      req(cookie),
    );
    await runJobs(created.appointmentId);
    // El aviso de la reserva tampoco sale: la reserva sí existe.
    assert.equal((await jobs(created.appointmentId))[0].status, 'SUPPRESSED_BUDGET');

    const result = await controller.cancel(created.appointmentId, req(cookie));
    assert.equal(result.ok, true);
    const cancelled = await db.appointment.findUniqueOrThrow({
      where: { id: created.appointmentId },
    });
    assert.equal(cancelled.status, 'CANCELLED');
    await runJobs(created.appointmentId);
    const notice = (await jobs(created.appointmentId)).find((j) => j.kind === 'CANCELLED')!;
    assert.equal(notice.status, 'SUPPRESSED_BUDGET');
    assert.match(notice.suppressedReason ?? '', /sesión/);
    assert.equal(birdCalls, 0);
    // Un aviso suprimido no se reintenta nunca: el worker no lo vuelve a tomar.
    await processJob(notice.id, countingProviders);
    assert.equal(birdCalls, 0);
    assert.equal(
      (await db.automationJob.findUniqueOrThrow({ where: { id: notice.id } })).status,
      'SUPPRESSED_BUDGET',
    );
  },
);

test(
  'reschedule limit: 0→1→2 allowed, the third is rejected without calling Cal.com or Bird',
  { skip: !enabled },
  async () => {
    const controller = new BookingController();
    const { user, cookie } = await customer();
    trackUser(user.id);
    birdCalls = 0;
    const created = await controller.create(
      { start: future(3).toISOString(), request: 'Revisión de consola', whatsappConsent: true },
      req(cookie),
    );
    const id = created.appointmentId;
    await runJobs(id);
    const count = async () =>
      (await db.appointment.findUniqueOrThrow({ where: { id } })).rescheduleCount;
    assert.equal(await count(), 0);
    await controller.reschedule(id, { start: future(4).toISOString() }, req(cookie));
    assert.equal(await count(), 1);
    await runJobs(id);
    await controller.reschedule(id, { start: future(5).toISOString() }, req(cookie));
    assert.equal(await count(), MAX_RESCHEDULES);
    await runJobs(id);
    const birdBefore = birdCalls;
    const calBefore = calls.filter((c) => c.url.endsWith('/reschedule')).length;
    await assert.rejects(
      controller.reschedule(id, { start: future(6).toISOString() }, req(cookie)),
      (e: any) => e.getStatus() === 400 && e.getResponse().code === 'RESCHEDULE_LIMIT',
    );
    await runJobs(id);
    assert.equal(await count(), 2);
    assert.equal(calls.filter((c) => c.url.endsWith('/reschedule')).length, calBefore);
    assert.equal(birdCalls, birdBefore);
    // La cita sigue vigente con el último horario; cancelar sigue permitido.
    const current = await db.appointment.findUniqueOrThrow({ where: { id } });
    assert.equal(current.startsAt.getTime(), future(5).getTime());
    assert.equal((await controller.cancel(id, req(cookie))).ok, true);
  },
);

test(
  'reschedule_count = 1 + exhausted WhatsApp budget → second reschedule allowed, notice suppressed',
  { skip: !enabled },
  async () => {
    const controller = new BookingController();
    const { user, cookie, sessionKey } = await customer();
    trackUser(user.id);
    const created = await controller.create(
      { start: future(3).toISOString(), request: 'Cambio de batería', whatsappConsent: true },
      req(cookie),
    );
    const id = created.appointmentId;
    await db.appointment.update({ where: { id }, data: { rescheduleCount: 1 } });
    const spentOn = await exhaustSessionBudget(sessionKey);
    cleanup.push(() => db.appointment.delete({ where: { id: spentOn } }));
    await runJobs(id);
    birdCalls = 0;
    const result = await controller.reschedule(id, { start: future(4).toISOString() }, req(cookie));
    assert.equal(result.ok, true);
    assert.equal((await db.appointment.findUniqueOrThrow({ where: { id } })).rescheduleCount, 2);
    await runJobs(id);
    const notice = (await jobs(id)).find((j) => j.kind === 'RESCHEDULED')!;
    assert.equal(notice.status, 'SUPPRESSED_BUDGET');
    assert.equal(birdCalls, 0);
  },
);

test(
  'retries of create / confirm / reschedule / cancel never duplicate actions or WhatsApp messages',
  { skip: !enabled },
  async () => {
    const controller = new BookingController();
    const { user, cookie } = await customer();
    trackUser(user.id);
    const tech = await customer('TECHNICIAN');
    trackUser(tech.user.id);
    birdCalls = 0;
    const creates = () => calls.filter((c) => c.url.endsWith('/bookings')).length;
    const before = creates();
    const body = {
      start: future(3).toISOString(),
      request: 'Limpieza de PS5',
      whatsappConsent: true,
    };
    const key = { 'idempotency-key': `create-${randomUUID()}` };
    const first = await controller.create(body, req(cookie, key));
    const again = await controller.create(body, req(cookie, key));
    // Sin clave (otra pestaña, recarga): la misma reserva reciente, no otra.
    const reload = await controller.create(body, req(cookie));
    assert.equal(again.appointmentId, first.appointmentId);
    assert.equal(reload.appointmentId, first.appointmentId);
    assert.equal(creates() - before, 1);
    const id = first.appointmentId;
    assert.equal((await jobs(id)).filter((j) => j.kind === 'INITIAL').length, 1);

    // Confirmar dos veces (doble pulsación): un solo CONFIRMED.
    const staff = { ...tech.user, role: 'TECHNICIAN' } as StaffUser;
    await confirmAppointment(staff, id);
    const second = await confirmAppointment(staff, id);
    assert.equal(second.alreadyConfirmed, true);
    assert.equal((await jobs(id)).filter((j) => j.kind === 'CONFIRMED').length, 1);

    // Un reintento técnico del worker no reenvía un mensaje ya enviado.
    await runJobs(id);
    const sent = birdCalls;
    for (const job of await jobs(id)) await processJob(job.id, countingProviders);
    assert.equal(birdCalls, sent);

    // Reprogramar con la misma clave: un solo cambio, un solo aviso.
    const rKey = { 'idempotency-key': `resched-${randomUUID()}` };
    const target = { start: future(4).toISOString() };
    await controller.reschedule(id, target, req(cookie, rKey));
    await controller.reschedule(id, target, req(cookie, rKey));
    // Mismo horario sin clave: sin cambios.
    const same = await controller.reschedule(id, target, req(cookie));
    assert.equal(same.unchanged, true);
    assert.equal((await db.appointment.findUniqueOrThrow({ where: { id } })).rescheduleCount, 1);
    assert.equal((await jobs(id)).filter((j) => j.kind === 'RESCHEDULED').length, 1);

    // Cancelar dos veces: CANCELLED → CANCELLED no avisa de nuevo.
    await controller.cancel(id, req(cookie));
    const repeat = await controller.cancel(id, req(cookie));
    assert.equal(repeat.alreadyCancelled, true);
    assert.equal((await jobs(id)).filter((j) => j.kind === 'CANCELLED').length, 1);
    await runJobs(id);
    await runJobs(id);
    const cancelSends = (await jobs(id)).filter(
      (j) => j.kind === 'CANCELLED' && j.status === 'SENT',
    );
    assert.equal(cancelSends.length, 1);
  },
);

test(
  'a blocked number cannot book, register or request an OTP, and never reaches Bird',
  { skip: !enabled },
  async () => {
    const admin = await customer('ADMIN');
    trackUser(admin.user.id);
    const people = new PeopleAdminController();
    const blocked = testPhone();
    cleanup.push(() => db.blockedPhone.deleteMany({ where: { phone: blocked } }));
    // Formato nacional: se normaliza a E.164.
    await people.block(
      { phone: `0${blocked.slice(4)}`, reason: 'Spam interno' },
      req(admin.cookie),
    );
    assert.ok(await db.blockedPhone.findUnique({ where: { phone: blocked } }));
    const before = calls.length;
    await assert.rejects(
      new BookingController().create(
        {
          start: future(3).toISOString(),
          name: 'Bloqueado',
          phone: blocked,
          request: 'Reparación',
          whatsappConsent: true,
        },
        req(),
      ),
      (e: any) =>
        e.getStatus() === 403 &&
        e.getResponse().code === 'PHONE_BLOCKED' &&
        !JSON.stringify(e.getResponse()).includes('Spam'),
    );
    assert.equal(calls.length, before);
    let otps = 0;
    const wa: WhatsAppOtpProvider = {
      name: 'TEST',
      async sendAuthenticationCode() {
        otps++;
        return { messageId: 'x' };
      },
    };
    const auth = new AuthController(new VerificationService(wa));
    await assert.rejects(
      auth.register(
        {
          firstName: 'Ana',
          lastName: 'Bloqueo',
          email: `bloq-${randomUUID()}@example.com`,
          phone: blocked,
          password: 'clave-muy-segura-123',
        },
        req(),
      ),
      (e: any) => e.getStatus() === 403,
    );
    assert.equal(otps, 0);
    cleanup.push(() => db.phoneChallenge.deleteMany({ where: { phone: blocked } }));

    // Avisos ya encolados para ese número: suprimidos, sin llamar a Bird.
    const appointment = await db.appointment.create({
      data: {
        contactName: 'Bloqueado',
        contactPhone: blocked,
        whatsappConsentAt: new Date(),
        title: 'X',
        device: 'X',
        startsAt: future(3),
        endsAt: new Date(future(3).getTime() + 3600000),
        address: '',
        technician: '',
        source: 'INSTAFIX_API',
      },
    });
    cleanup.push(() => db.appointment.delete({ where: { id: appointment.id } }));
    await db.automationJob.create({
      data: {
        dedupeKey: `${appointment.id}:0:INITIAL`,
        appointmentId: appointment.id,
        revision: 0,
        kind: 'INITIAL',
        dueAt: new Date(),
        expiresAt: appointment.startsAt,
        recipient: blocked,
      },
    });
    birdCalls = 0;
    await runJobs(appointment.id);
    assert.equal((await jobs(appointment.id))[0].status, 'SUPPRESSED_BLOCKED');
    assert.equal(birdCalls, 0);
    // Desbloquear.
    await people.unblock(encodeURIComponent(blocked), req(admin.cookie));
    assert.equal(await db.blockedPhone.count({ where: { phone: blocked } }), 0);
    assert.ok(await db.adminAction.count({ where: { target: blocked } }));
  },
);

test(
  'kill switch WHATSAPP_SENDING_ENABLED=false: appointments keep working, Bird gets no calls',
  { skip: !enabled },
  async () => {
    const controller = new BookingController();
    const { user, cookie } = await customer();
    trackUser(user.id);
    process.env.WHATSAPP_SENDING_ENABLED = 'false';
    try {
      birdCalls = 0;
      const created = await controller.create(
        { start: future(3).toISOString(), request: 'Revisión general', whatsappConsent: true },
        req(cookie),
      );
      await runJobs(created.appointmentId);
      assert.equal((await jobs(created.appointmentId))[0].status, 'SUPPRESSED_DISABLED');
      assert.equal((await controller.cancel(created.appointmentId, req(cookie))).ok, true);
      await runJobs(created.appointmentId);
      assert.equal(birdCalls, 0);
    } finally {
      delete process.env.WHATSAPP_SENDING_ENABLED;
    }
  },
);

test(
  'admin only: delete appointments (soft), block numbers and list users; never hashes',
  { skip: !enabled },
  async () => {
    const admin = await customer('ADMIN');
    const tech = await customer('TECHNICIAN');
    const client = await customer();
    for (const u of [admin, tech, client]) trackUser(u.user.id);
    const people = new PeopleAdminController();
    const appointments = new AppointmentsController();
    for (const intruder of [tech, client]) {
      await assert.rejects(
        people.accounts(req(intruder.cookie)),
        (e: any) => e.getStatus() === 403,
      );
      await assert.rejects(
        people.block({ phone: testPhone() }, req(intruder.cookie)),
        (e: any) => e.getStatus() === 403,
      );
      await assert.rejects(
        appointments.deleteAppointment(randomUUID(), { confirm: true }, req(intruder.cookie)),
        (e: any) => e.getStatus() === 403,
      );
    }
    await assert.rejects(people.accounts(req()), (e: any) => e.getStatus() === 401);

    const listed = await people.accounts(req(admin.cookie), client.user.phone.slice(-7), '1', '5');
    assert.ok(listed.items.some((u) => u.id === client.user.id));
    assert.equal(listed.page, 1);
    assert.ok(listed.total >= 1);
    const raw = JSON.stringify(listed);
    assert.ok(
      !raw.includes('passwordHash') && !raw.includes('tokenHash') && !raw.includes('codeHash'),
    );

    const created = await new BookingController().create(
      { start: future(3).toISOString(), request: 'Eliminar luego', whatsappConsent: true },
      req(client.cookie),
    );
    // Sin confirmación explícita no se elimina.
    await assert.rejects(
      appointments.deleteAppointment(created.appointmentId, {}, req(admin.cookie)),
      (e: any) => e.getStatus() === 400,
    );
    const done = await appointments.deleteAppointment(
      created.appointmentId,
      { confirm: true },
      req(admin.cookie),
    );
    assert.equal(done.calReleased, true);
    const row = await db.appointment.findUniqueOrThrow({ where: { id: created.appointmentId } });
    // Eliminada ≠ cancelada: el historial se conserva y deja de mostrarse.
    assert.ok(row.deletedAt);
    assert.notEqual(row.status, 'CANCELLED');
    assert.ok(
      !(await appointments.adminAppointments(req(admin.cookie))).some((a) => a.id === row.id),
    );
    assert.equal(
      await db.automationJob.count({ where: { appointmentId: row.id, status: 'PENDING' } }),
      0,
    );
    assert.equal(
      await db.appointmentActivity.count({ where: { appointmentId: row.id, action: 'DELETED' } }),
      1,
    );
  },
);

test('client IP: X-Real-IP only in production (set by Caddy); X-Forwarded-For is never trusted', () => {
  const saved = process.env.NODE_ENV;
  const request = (headers: Record<string, string>) =>
    ({ headers, socket: { remoteAddress: '::ffff:172.18.0.5' } }) as unknown as Request;
  try {
    process.env.NODE_ENV = 'production';
    assert.equal(clientIp(request({ 'x-real-ip': '181.39.10.20' })), '181.39.10.20');
    assert.equal(clientIp(request({ 'x-forwarded-for': '1.2.3.4' })), '172.18.0.5');
    assert.equal(clientIp(request({ 'x-real-ip': 'no-es-ip' })), '172.18.0.5');
    process.env.NODE_ENV = 'development';
    assert.equal(clientIp(request({ 'x-real-ip': '181.39.10.20' })), '172.18.0.5');
  } finally {
    process.env.NODE_ENV = saved;
  }
});
