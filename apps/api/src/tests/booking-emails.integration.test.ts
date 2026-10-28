import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Request } from 'express';
import { newToken, tokenHash } from '../auth/security';
import { BookingController } from '../booking/booking.controller';
import { db } from '../database/client';
import { setEmailProvider } from '../mail/email.service';

// Configuración típica: sin buzón puente de Cal.com y sin APPOINTMENT_EMAILS_ENABLED definido.
const enabled = process.env.INSTAFIX_INTEGRATION === '1';
Object.assign(process.env, {
  CAL_API_KEY: 'test-key',
  CAL_API_VERSION: '2026-02-25',
  CAL_EVENT_TYPE_ID: '424242',
  SMTP_HOST: 'smtp-relay.brevo.com',
  SMTP_FROM: 'Instafix <citas@instafix.ec>',
  SMTP_USER: 'test',
  SMTP_PASSWORD: 'test',
});
delete process.env.CAL_ATTENDEE_RELAY_EMAIL;
delete process.env.APPOINTMENT_EMAILS_ENABLED;

const emails: { to: string; subject: string }[] = [];
setEmailProvider({
  name: 'TEST',
  async send(to, message) {
    emails.push({ to, subject: message.subject });
    return { messageId: `<${randomUUID()}@brevo>` };
  },
});
const calBodies: any[] = [];
/** Simula un tipo de evento de Cal.com que vuelve a exigir correo de asistente. */
let calRequiresEmail = false;
const original = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: RequestInit) => {
  const url = String(input);
  if (!url.startsWith('https://api.cal.com/')) return original(input, init);
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  if (url.includes('/slots'))
    return Response.json({
      status: 'success',
      data: { [start().slice(0, 10)]: [{ start: start() }] },
    });
  if (url.endsWith('/bookings') && init?.method === 'POST') {
    calBodies.push(body);
    if (calRequiresEmail && !body.attendee.email)
      return Response.json(
        {
          status: 'error',
          error: { code: 'BadRequestException', message: 'attendee email is required' },
        },
        { status: 400 },
      );
    return Response.json({
      status: 'success',
      data: {
        uid: `uid-${randomUUID()}`,
        status: 'pending',
        start: body.start,
        end: new Date(new Date(body.start).getTime() + 3600000).toISOString(),
      },
    });
  }
  if (url.endsWith('/cancel')) return Response.json({ status: 'success', data: {} });
  return Response.json({}, { status: 404 });
}) as typeof fetch;

const start = () => {
  const d = new Date(Date.now() + 3 * 86400000);
  d.setUTCHours(18, 0, 0, 0);
  return d.toISOString();
};
const req = (cookie = '') =>
  ({ headers: { origin: 'http://localhost:5173', cookie } }) as unknown as Request;
const phone = () => `+59398${randomInt(1000000, 9999999)}`;

test(
  'booking and cancellation emails reach the customer; Cal.com never gets their address',
  { skip: !enabled },
  async () => {
    const controller = new BookingController();
    const email = `cliente-${randomUUID()}@example.com`;
    const contact = phone();
    try {
      // Invitado con correo.
      const result = await controller.create(
        {
          start: start(),
          name: 'Cliente Correo',
          email,
          phone: contact,
          request: 'Mi PS5 se apaga',
          whatsappConsent: true,
        },
        req(),
      );
      assert.equal(result.email.status, 'SENT');
      assert.deepEqual(
        emails.filter((e) => e.to === email).map((e) => e.subject),
        ['Recibimos tu solicitud de visita · Instafix'],
      );
      // Cal.com no recibe ningún correo: no puede escribir al cliente ni duplicar avisos.
      assert.equal('email' in calBodies.at(-1).attendee, false);
      assert.equal(JSON.stringify(calBodies.at(-1)).includes(email), false);
    } finally {
      await db.appointment.deleteMany({ where: { contactPhone: contact } });
    }

    // Cliente con cuenta: agenda y cancela desde Mi cuenta.
    const accountEmail = `cuenta-${randomUUID()}@example.com`;
    const user = await db.user.create({
      data: {
        name: 'Cuenta Correo',
        phone: phone(),
        email: accountEmail,
        passwordHash: 'x',
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
    try {
      const booked = await controller.create(
        { start: start(), request: 'Laptop lenta', whatsappConsent: true },
        req(cookie),
      );
      await controller.cancel(booked.appointmentId, req(cookie));
      assert.deepEqual(
        emails.filter((e) => e.to === accountEmail).map((e) => e.subject),
        ['Recibimos tu solicitud de visita · Instafix', 'Tu cita con Instafix fue cancelada'],
      );
    } finally {
      await db.appointment.deleteMany({ where: { userId: user.id } });
      await db.user.delete({ where: { id: user.id } });
    }
  },
);

test('a Brevo rejection is recorded with its real SMTP reason', { skip: !enabled }, async () => {
  const { sendEmail } = await import('../mail/email.service');
  const previous = setEmailProvider({
    name: 'BREVO',
    async send() {
      throw Object.assign(new Error('Message failed'), {
        responseCode: 550,
        response: '550 5.7.1 Sender citas@instafix.ec is not verified',
      });
    },
  });
  const to = `rechazo-${randomUUID()}@example.com`;
  try {
    await assert.rejects(
      sendEmail({ to, kind: 'TEST', message: { subject: 's', text: 't', html: 'h' } }),
      (e: any) => /550 .*not verified/.test(e.reason) && !e.reason.includes('citas@instafix.ec'),
    );
    const log = await db.communicationLog.findFirstOrThrow({
      where: { kind: 'TEST', status: 'FAILED' },
      orderBy: { createdAt: 'desc' },
    });
    assert.match(log.error || '', /550 5\.7\.1 Sender \[correo\] is not verified/);
  } finally {
    setEmailProvider(previous);
  }
});

test(
  'si Cal.com exige correo, se reintenta una vez con el buzón de Instafix (nunca el del cliente)',
  { skip: !enabled },
  async () => {
    const controller = new BookingController();
    const email = `cliente-${randomUUID()}@example.com`;
    const contact = phone();
    calRequiresEmail = true;
    const before = calBodies.length;
    try {
      const result = await controller.create(
        {
          start: start(),
          name: 'Cliente Respaldo',
          email,
          phone: contact,
          request: 'Cambio de joysticks',
          whatsappConsent: true,
        },
        req(),
      );
      assert.ok(result.appointmentId);
      const sent = calBodies.slice(before);
      assert.equal(sent.length, 2, 'un intento sin correo y un reintento');
      assert.equal('email' in sent[0].attendee, false);
      assert.equal(sent[1].attendee.email, 'citas@instafix.ec');
      assert.equal(JSON.stringify(sent).includes(email), false);
    } finally {
      calRequiresEmail = false;
      await db.appointment.deleteMany({ where: { contactPhone: contact } });
    }
  },
);
