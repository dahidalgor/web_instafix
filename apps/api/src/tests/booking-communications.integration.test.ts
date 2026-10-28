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

test(
  'Instafix creates the Cal booking, saves it and sends exactly one confirmation; Cal never gets the client email',
  { skip: !enabled },
  async () => {
    const controller = new BookingController();
    const phone = testPhone();
    const email = `book-${randomUUID()}@example.com`;
    const uid = `test-${randomUUID()}`;
    const start = future(3);
    try {
      // Carrera: el webhook BOOKING_REQUESTED llega antes que la respuesta de la API.
      calHandler = async (call) => {
        if (call.url.endsWith('/bookings') && call.method === 'POST') {
          await receiveCalWebhook(webhook('BOOKING_REQUESTED', uid, start, phone));
          return Response.json(bookingData(uid, start));
        }
        return Response.json({}, { status: 404 });
      };
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
      const create = calCalls.find((c) => c.url.endsWith('/bookings'))!;
      // A Cal.com no se le envía ningún correo de asistente: solo el teléfono.
      assert.equal('email' in create.body.attendee, false);
      assert.equal(create.body.attendee.phoneNumber, phone);
      assert.equal(JSON.stringify(create.body).includes(email), false);
      assert.equal(create.body.bookingFieldsResponses.notes, 'Mi PS5 se apaga');
      assert.equal(await db.appointment.count({ where: { calUid: uid } }), 1);
      const appointment = await db.appointment.findUniqueOrThrow({ where: { calUid: uid } });
      assert.equal(appointment.source, 'INSTAFIX_API');
      assert.equal(appointment.contactEmail, email);
      assert.equal(appointment.contactPhone, phone);
      assert.equal(result.email.status, 'SENT');
      assert.equal(result.account, 'GUEST');
      assert.equal(sentTo(email, /Recibimos tu solicitud/), 1);
      // BOOKING_CREATED/REQUESTED repetidos no generan otro correo.
      await receiveCalWebhook(
        webhook('BOOKING_CREATED', uid, start, phone, { status: 'ACCEPTED' }),
      );
      await receiveCalWebhook(webhook('BOOKING_REQUESTED', uid, start, phone));
      assert.equal(emails.filter((e) => e.to === email).length, 1);
      assert.equal(
        await db.notification.count({ where: { appointmentId: appointment.id, channel: 'EMAIL' } }),
        1,
      );
      // WhatsApp inicial (pedir ubicación) encolado una sola vez.
      assert.equal(
        await db.automationJob.count({ where: { appointmentId: appointment.id, kind: 'INITIAL' } }),
        1,
      );
    } finally {
      await db.appointment.deleteMany({ where: { contactPhone: phone } });
    }
  },
);

test('Cal.com failure creates nothing and sends nothing', { skip: !enabled }, async () => {
  const controller = new BookingController();
  const phone = testPhone();
  const email = `fail-${randomUUID()}@example.com`;
  calHandler = async () => Response.json({ error: 'slot unavailable' }, { status: 400 });
  await assert.rejects(
    controller.create(
      {
        start: future(4).toISOString(),
        name: 'Cliente',
        email,
        phone,
        request: 'Laptop lenta',
        whatsappConsent: true,
      },
      req(),
    ),
    // Sin evidencia de que el horario se ocupó (Cal.com también falla al consultar horarios),
    // no se culpa al horario: es un rechazo de la agenda.
    (e: any) => e.getStatus() === 502 && e.getResponse().code === 'BOOKING_REJECTED',
  );
  assert.equal(await db.appointment.count({ where: { contactPhone: phone } }), 0);
  assert.equal(emails.filter((e) => e.to === email).length, 0);
});

test(
  'customer reschedule and cancel: one email each, webhooks do not duplicate, Cal failure sends nothing',
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
    const uid = `test-${randomUUID()}`;
    const newUid = `test-${randomUUID()}`;
    const start = future(5);
    const moved = future(6, 15);
    try {
      calHandler = async (call) => {
        if (call.url.endsWith('/bookings'))
          return Response.json(bookingData(uid, start, 'accepted'));
        if (call.url.endsWith(`/${uid}/reschedule`))
          return Response.json(bookingData(newUid, moved, 'accepted'));
        if (call.url.endsWith('/cancel'))
          return Response.json({ status: 'error' }, { status: 500 });
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
      const appointment = await db.appointment.findUniqueOrThrow({
        where: { id: result.appointmentId },
      });
      assert.equal(appointment.userId, user.id);
      assert.equal(appointment.contactPhone, phone);
      assert.equal(sentTo(email, /Recibimos tu solicitud/), 1);
      // Agendada ≠ confirmada: ningún correo de confirmación hasta que un técnico la confirme.
      assert.equal(sentTo(email, /confirmada/), 0);

      await controller.reschedule(appointment.id, { start: moved.toISOString() }, req(cookie));
      const after = await db.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
      assert.equal(after.calUid, newUid);
      assert.equal(after.startsAt.getTime(), moved.getTime());
      assert.equal(sentTo(email, /reprogramada/), 1);
      // Webhook de la misma reprogramación: sin segunda fila ni segundo correo.
      await receiveCalWebhook(
        webhook('BOOKING_RESCHEDULED', newUid, moved, phone, {
          rescheduleUid: uid,
          status: 'ACCEPTED',
        }),
      );
      assert.equal(sentTo(email, /reprogramada/), 1);
      assert.equal(await db.appointment.count({ where: { userId: user.id } }), 1);

      // Cancelación fallida en Cal.com: ni cambio de estado ni correo. Aunque Cal.com aceptó la
      // reserva, sigue pendiente hasta que un técnico la confirme.
      await assert.rejects(controller.cancel(appointment.id, req(cookie)));
      assert.equal(
        (await db.appointment.findUniqueOrThrow({ where: { id: appointment.id } })).status,
        'PENDING_LOCATION',
      );
      assert.equal(sentTo(email, /cancelada/), 0);

      calHandler = async () => Response.json({ status: 'success', data: {} });
      await controller.cancel(appointment.id, req(cookie));
      assert.equal(
        (await db.appointment.findUniqueOrThrow({ where: { id: appointment.id } })).status,
        'CANCELLED',
      );
      assert.equal(sentTo(email, /cancelada/), 1);
      await receiveCalWebhook(webhook('BOOKING_CANCELLED', newUid, moved, phone));
      assert.equal(sentTo(email, /cancelada/), 1);
    } finally {
      await db.appointment.deleteMany({ where: { userId: user.id } });
      await db.user.delete({ where: { id: user.id } });
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
    const start = future(7);
    try {
      calHandler = async () => Response.json(bookingData(uid, start));
      await controller.create(
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
      await receiveCalWebhook(webhook('BOOKING_CANCELLED', uid, start, phone));
      await receiveCalWebhook(webhook('BOOKING_CANCELLED', uid, start, phone));
      // El webhook responde sin esperar al proveedor; la bandeja entrega el aviso.
      const worker = new NotificationWorker();
      await worker.tick();
      await worker.tick();
      assert.equal(sentTo(email, /cancelada/), 1);
    } finally {
      await db.appointment.deleteMany({ where: { contactPhone: phone } });
    }
  },
);
