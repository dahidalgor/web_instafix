import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Request } from 'express';
import { hashPassword, newToken, tokenHash } from '../auth/security';
import { BookingController } from '../booking/booking.controller';
import { db } from '../database/client';
import { receiveCalWebhook } from '../integrations/cal-webhook';
import { setEmailProvider } from '../mail/email.service';
import { NotificationWorker } from '../notifications/notification.service';
import type { StaffUser } from '../auth/session';
import { confirmAppointment } from '../staff/staff-appointments.service';

const enabled = process.env.INSTAFIX_INTEGRATION === '1';
const RELAY = 'reservas@instafix.ec';
Object.assign(process.env, {
  CAL_API_KEY: 'test-key',
  CAL_API_VERSION: '2026-02-25',
  CAL_EVENT_TYPE_ID: '424242',
  CAL_ATTENDEE_RELAY_EMAIL: RELAY,
  APPOINTMENT_EMAILS_ENABLED: 'true',
  SMTP_HOST: process.env.SMTP_HOST || 'smtp-relay.brevo.com',
  SMTP_FROM: process.env.SMTP_FROM || 'Instafix <test@instafix.ec>',
  SMTP_USER: process.env.SMTP_USER || 'test',
  SMTP_PASSWORD: process.env.SMTP_PASSWORD || 'test',
});
const emails: { to: string; subject: string }[] = [];
setEmailProvider({
  name: 'TEST',
  async send(to, message) {
    emails.push({ to, subject: message.subject });
    return { messageId: `<${randomUUID()}@brevo>` };
  },
});
const testPhone = () => `+59398${String(randomInt(1000000, 9999999))}`;
const req = (cookie = '') =>
  ({ headers: { origin: 'http://localhost:5173', cookie } }) as unknown as Request;
const future = (days: number, hourUtc = 20) => {
  const d = new Date(Date.now() + days * 86400000);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d;
};

type CalCall = { url: string; method: string; body: any };
const calCalls: CalCall[] = [];
let calHandler: (call: CalCall) => Promise<Response> = async () =>
  Response.json({}, { status: 500 });
const original = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: RequestInit) => {
  const url = String(input);
  if (!url.startsWith('https://api.cal.com/')) return original(input, init);
  const call = {
    url,
    method: init?.method || 'GET',
    body: init?.body ? JSON.parse(String(init.body)) : null,
  };
  calCalls.push(call);
  return calHandler(call);
}) as typeof fetch;

const bookingData = (uid: string, start: Date, status = 'pending') => ({
  status: 'success',
  data: {
    uid,
    status,
    start: start.toISOString(),
    end: new Date(start.getTime() + 3600000).toISOString(),
  },
});
function webhook(
  trigger: string,
  uid: string,
  start: Date,
  phone: string,
  extra: Record<string, unknown> = {},
) {
  return {
    triggerEvent: trigger,
    createdAt: new Date().toISOString(),
    payload: {
      uid,
      eventTypeId: 424242,
      startTime: start.toISOString(),
      endTime: new Date(start.getTime() + 3600000).toISOString(),
      attendees: [{ name: 'Cliente Prueba', email: RELAY, phoneNumber: phone }],
      responses: {
        servicio: { value: 'Mi PS5 se apaga' },
        whatsappConsent: { value: true },
        attendeePhoneNumber: { value: phone },
      },
      status: 'PENDING',
      metadata: { instafixSource: 'api' },
      ...extra,
    },
  };
}
const sentTo = (to: string, subject: RegExp) =>
  emails.filter((e) => e.to === to && subject.test(e.subject)).length;

/** Técnico que confirma las citas en estas pruebas. */
async function technician() {
  return db.user.create({
    data: {
      name: 'Técnico Agenda',
      phone: testPhone(),
      passwordHash: 'x',
      role: 'TECHNICIAN',
      phoneVerifiedAt: new Date(),
    },
  });
}
const creates = () => calCalls.filter((c) => c.url.endsWith('/bookings') && c.method === 'POST');

test(
  'agendar guarda una reserva provisional (Cal.com no recibe nada); al confirmar el técnico se crea en Cal.com sin el correo del cliente',
  { skip: !enabled },
  async () => {
    const controller = new BookingController();
    const phone = testPhone();
    const email = `book-${randomUUID()}@example.com`;
    const uid = `test-${randomUUID()}`;
    const start = future(30 + randomInt(0, 300));
    const tech = await technician();
    try {
      calHandler = async (call) => {
        if (call.url.endsWith('/bookings') && call.method === 'POST') {
          // Carrera: el webhook BOOKING_REQUESTED llega antes que la respuesta de la API.
          await receiveCalWebhook(
            webhook('BOOKING_REQUESTED', uid, start, phone, {
              metadata: {
                instafixSource: 'api',
                instafixAppointmentId: call.body.metadata.instafixAppointmentId,
              },
            }),
          );
          return Response.json(bookingData(uid, start));
        }
        if (call.url.includes(`/bookings/${uid}`) && call.method === 'GET')
          return Response.json({ status: 'success', data: { uid, status: 'pending' } });
        if (call.url.endsWith('/confirm')) return Response.json({ status: 'success' });
        return Response.json({}, { status: 404 });
      };
      const before = creates().length;
      const result = await controller.create(
        {
          start: start.toISOString(),
          name: 'Cliente Prueba',
          email,
          phone,
          request: 'Mi PS5 se apaga',
          whatsappConsent: true,
        },
        req(),
      );
      assert.equal(creates().length, before, 'agendar no crea nada en Cal.com');
      const held = await db.appointment.findUniqueOrThrow({ where: { id: result.appointmentId } });
      assert.equal(held.calUid, null);
      assert.equal(held.source, 'INSTAFIX_API');
      assert.equal(held.status, 'PENDING_LOCATION');
      assert.ok(held.holdExpiresAt && held.holdExpiresAt > new Date());
      assert.equal(held.contactEmail, email);
      assert.equal(result.email.status, 'SENT');
      assert.equal(result.account, 'GUEST');
      assert.equal(sentTo(email, /Recibimos tu solicitud/), 1);
      assert.equal(
        await db.automationJob.count({ where: { appointmentId: held.id, kind: 'INITIAL' } }),
        1,
      );

      // El técnico confirma: recién ahora se crea (y se acepta) la reserva en Cal.com.
      const confirmed = await confirmAppointment(
        { ...tech, role: 'TECHNICIAN' } as StaffUser,
        held.id,
      );
      assert.equal(confirmed.cal, 'SYNCED');
      const create = creates().at(-1)!;
      assert.equal(creates().length, before + 1);
      // A Cal.com no se le envía ningún correo de asistente: solo el teléfono.
      assert.equal('email' in create.body.attendee, false);
      assert.equal(create.body.attendee.phoneNumber, phone);
      assert.equal(JSON.stringify(create.body).includes(email), false);
      assert.equal(create.body.bookingFieldsResponses.notes, 'Mi PS5 se apaga');
      assert.equal(create.body.metadata.instafixAppointmentId, held.id);
      // El webhook que llegó antes se enlazó a la misma cita: no hay otra fila ni otro aviso.
      assert.equal(await db.appointment.count({ where: { calUid: uid } }), 1);
      const after = await db.appointment.findUniqueOrThrow({ where: { id: held.id } });
      assert.equal(after.calUid, uid);
      assert.equal(after.status, 'CONFIRMED');
      assert.equal(after.calStatus, 'accepted');
      await receiveCalWebhook(
        webhook('BOOKING_CREATED', uid, start, phone, { status: 'ACCEPTED' }),
      );
      assert.equal(sentTo(email, /Recibimos tu solicitud/), 1);
      assert.equal(await db.appointment.count({ where: { contactPhone: phone } }), 1);
    } finally {
      await db.appointment.deleteMany({ where: { contactPhone: phone } });
      await db.user.delete({ where: { id: tech.id } });
    }
  },
);

test(
  'dos clientes no pueden quedarse el mismo horario: la reserva provisional lo ocupa',
  { skip: !enabled },
  async () => {
    const controller = new BookingController();
    const first = testPhone();
    const second = testPhone();
    const start = future(30 + randomInt(0, 300));
    calHandler = async () => Response.json({}, { status: 404 });
    const body = (phone: string) => ({
      start: start.toISOString(),
      name: 'Cliente',
      phone,
      request: 'Revisión',
      whatsappConsent: true,
    });
    try {
      await controller.create(body(first), req());
      await assert.rejects(
        controller.create(body(second), req()),
        (e: any) => e.getStatus() === 409 && e.getResponse().code === 'SLOT_UNAVAILABLE',
      );
      assert.equal(await db.appointment.count({ where: { contactPhone: second } }), 0);
    } finally {
      await db.appointment.deleteMany({ where: { contactPhone: { in: [first, second] } } });
    }
  },
);

test(
  'Cal.com rechaza al confirmar: la cita sigue pendiente, sin correo de confirmación',
  { skip: !enabled },
  async () => {
    const controller = new BookingController();
    const phone = testPhone();
    const email = `fail-${randomUUID()}@example.com`;
    const start = future(30 + randomInt(0, 300));
    const tech = await technician();
    calHandler = async () => Response.json({}, { status: 404 });
    try {
      const { appointmentId } = await controller.create(
        {
          start: start.toISOString(),
          name: 'Cliente',
          email,
          phone,
          request: 'Laptop lenta',
          whatsappConsent: true,
        },
        req(),
      );
      // Cal.com rechaza la reserva y su disponibilidad ya no ofrece ese horario.
      calHandler = async (call) =>
        call.url.includes('/slots')
          ? Response.json({ status: 'success', data: {} })
          : Response.json({ error: 'slot unavailable' }, { status: 400 });
      await assert.rejects(
        confirmAppointment({ ...tech, role: 'TECHNICIAN' } as StaffUser, appointmentId),
        (e: any) => e.getStatus() === 409 && /ya no está libre en Cal\.com/.test(e.message),
      );
      const row = await db.appointment.findUniqueOrThrow({ where: { id: appointmentId } });
      assert.equal(row.status, 'PENDING_LOCATION');
      assert.equal(row.assignedTechnicianId, null);
      assert.equal(row.calUid, null);
      assert.match(row.automationIssue ?? '', /ya no está libre en Cal\.com/);
      assert.equal(sentTo(email, /confirmada/), 0);
    } finally {
      await db.appointment.deleteMany({ where: { contactPhone: phone } });
      await db.user.delete({ where: { id: tech.id } });
    }
  },
);

test(
  'customer reschedule and cancel: one email each; a confirmed visit leaves Cal.com when it goes back to pending',
  { skip: !enabled },
  async () => {
    const controller = new BookingController();
    const phone = testPhone();
    const email = `acct-${randomUUID()}@example.com`;
    const user = await db.user.create({
      data: {
        name: 'Cuenta Prueba',
        phone,
        email,
        passwordHash: await hashPassword('clave-muy-segura-1'),
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
    const tech = await technician();
    const uid = `test-${randomUUID()}`;
    const base = 30 + randomInt(0, 300);
    const start = future(base);
    const moved = future(base + 1, 15);
    const later = future(base + 2, 16);
    const cancelled: string[] = [];
    try {
      calHandler = async (call) => {
        if (call.url.endsWith('/bookings') && call.method === 'POST')
          return Response.json(bookingData(uid, new Date(call.body.start), 'accepted'));
        if (call.url.endsWith('/cancel')) {
          cancelled.push(call.url);
          return Response.json({ status: 'success', data: {} });
        }
        return Response.json({}, { status: 404 });
      };
      // Con sesión, los datos del formulario se ignoran: manda la cuenta verificada.
      const result = await controller.create(
        {
          start: start.toISOString(),
          name: 'Otro',
          phone: testPhone(),
          request: 'Cambio de pasta térmica',
          whatsappConsent: false,
        },
        req(cookie),
      );
      assert.equal(result.account, 'LINKED');
      const id = result.appointmentId;
      const appointment = await db.appointment.findUniqueOrThrow({ where: { id } });
      assert.equal(appointment.userId, user.id);
      assert.equal(appointment.contactPhone, phone);
      assert.equal(sentTo(email, /Recibimos tu solicitud/), 1);
      assert.equal(sentTo(email, /confirmada/), 0);

      // Reprogramar una reserva provisional: solo cambia en Instafix.
      await controller.reschedule(id, { start: moved.toISOString() }, req(cookie));
      let after = await db.appointment.findUniqueOrThrow({ where: { id } });
      assert.equal(after.startsAt.getTime(), moved.getTime());
      assert.equal(after.calUid, null);
      assert.equal(sentTo(email, /reprogramada/), 1);
      assert.equal(cancelled.length, 0);

      // Confirmada (ya en Cal.com) y reprogramada por el cliente: vuelve a pendiente y su
      // reserva en Cal.com se cancela; ese webhook no cancela la cita.
      await confirmAppointment({ ...tech, role: 'TECHNICIAN' } as StaffUser, id);
      assert.equal((await db.appointment.findUniqueOrThrow({ where: { id } })).calUid, uid);
      await controller.reschedule(id, { start: later.toISOString() }, req(cookie));
      after = await db.appointment.findUniqueOrThrow({ where: { id } });
      assert.equal(after.status, 'PENDING_LOCATION');
      assert.equal(after.assignedTechnicianId, null);
      assert.equal(after.calUid, null);
      assert.ok(after.holdExpiresAt);
      assert.ok(cancelled.some((url) => url.includes(uid)));
      await receiveCalWebhook(webhook('BOOKING_CANCELLED', uid, start, phone));
      assert.equal(
        (await db.appointment.findUniqueOrThrow({ where: { id } })).status,
        'PENDING_LOCATION',
      );
      assert.equal(sentTo(email, /reprogramada/), 2);

      // Cancelar una reserva provisional: no llama a Cal.com y avisa una vez.
      const calls = cancelled.length;
      await controller.cancel(id, req(cookie));
      assert.equal((await db.appointment.findUniqueOrThrow({ where: { id } })).status, 'CANCELLED');
      assert.equal(cancelled.length, calls);
      assert.equal(sentTo(email, /cancelada/), 1);
      const again = await controller.cancel(id, req(cookie));
      assert.equal(again.alreadyCancelled, true);
      assert.equal(sentTo(email, /cancelada/), 1);
    } finally {
      await db.appointment.deleteMany({ where: { userId: user.id } });
      await db.user.delete({ where: { id: user.id } });
      await db.user.delete({ where: { id: tech.id } });
    }
  },
);

test(
  'cancellation made by the host in Cal.com triggers one Instafix email',
  { skip: !enabled },
  async () => {
    const controller = new BookingController();
    const phone = testPhone();
    const email = `host-${randomUUID()}@example.com`;
    const uid = `test-${randomUUID()}`;
    const start = future(30 + randomInt(0, 300));
    const tech = await technician();
    try {
      calHandler = async (call) =>
        call.url.endsWith('/bookings') && call.method === 'POST'
          ? Response.json(bookingData(uid, start, 'accepted'))
          : Response.json({}, { status: 404 });
      const { appointmentId } = await controller.create(
        {
          start: start.toISOString(),
          name: 'Cliente',
          email,
          phone,
          request: 'Revisión de consola',
          whatsappConsent: true,
        },
        req(),
      );
      await confirmAppointment({ ...tech, role: 'TECHNICIAN' } as StaffUser, appointmentId);
      await receiveCalWebhook(webhook('BOOKING_CANCELLED', uid, start, phone));
      await receiveCalWebhook(webhook('BOOKING_CANCELLED', uid, start, phone));
      // El webhook responde sin esperar al proveedor; la bandeja entrega el aviso.
      const worker = new NotificationWorker();
      await worker.tick();
      await worker.tick();
      assert.equal(sentTo(email, /cancelada/), 1);
    } finally {
      await db.appointment.deleteMany({ where: { contactPhone: phone } });
      await db.user.delete({ where: { id: tech.id } });
    }
  },
);
