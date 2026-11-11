import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Request } from 'express';
import webpush from 'web-push';
import { BookingController } from '../booking/booking.controller';
import { sweepBookingHolds } from '../booking/hold-sweeper';
import type { StaffUser } from '../auth/session';
import { db } from '../database/client';
import { receiveCalWebhook } from '../integrations/cal-webhook';
import { setEmailProvider } from '../mail/email.service';
import { deliverNotification } from '../notifications/notification.service';
import { scheduleConfirmationReminders } from '../notifications/staff/staff-notifications';
import { endpointHash, setPushSender } from '../notifications/staff/web-push.channel';
import { confirmAppointment } from '../staff/staff-appointments.service';
import { processJob } from '../whatsapp/worker';
import { processWhatsAppWebhook, receiveWhatsAppWebhook } from '../whatsapp/webhook-inbox';

const enabled = process.env.INSTAFIX_INTEGRATION === '1';
const vapid = webpush.generateVAPIDKeys();
Object.assign(process.env, {
  CAL_API_KEY: 'test-key',
  CAL_API_VERSION: '2026-02-25',
  CAL_EVENT_TYPE_ID: '626262',
  APPOINTMENT_EMAILS_ENABLED: 'false',
  VAPID_PUBLIC_KEY: vapid.publicKey,
  VAPID_PRIVATE_KEY: vapid.privateKey,
  VAPID_SUBJECT: 'mailto:avisos@instafix.ec',
});
setEmailProvider({ name: 'TEST', send: async () => ({ messageId: null }) });
setPushSender(async () => {});

// Cal.com simulado: sin horarios (la revalidación se omite) y cancelaciones registradas.
const cancels: string[] = [];
let cancelFails = false;
const original = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: RequestInit) => {
  const url = String(input);
  if (!url.startsWith('https://api.cal.com/')) return original(input, init);
  if (url.endsWith('/cancel')) {
    if (cancelFails) return Response.json({}, { status: 503 });
    cancels.push(decodeURIComponent(url.split('/bookings/')[1].split('/')[0]));
    return Response.json({ status: 'success', data: {} });
  }
  if (url.endsWith('/bookings') && init?.method === 'POST') {
    const body = JSON.parse(String(init.body));
    return Response.json({
      status: 'success',
      data: {
        uid: `auto-${randomUUID()}`,
        status: 'accepted',
        start: body.start,
        end: new Date(new Date(body.start).getTime() + 7200000).toISOString(),
      },
    });
  }
  return Response.json({}, { status: 404 });
}) as typeof fetch;

// Cada reserva desde una IP distinta: el límite diario por IP no es lo que se prueba aquí.
const req = () =>
  ({
    headers: { origin: 'http://localhost:5173' },
    socket: { remoteAddress: `10.12.${randomInt(0, 255)}.${randomInt(1, 254)}` },
  }) as unknown as Request;
const phone = () => `+59391${randomInt(1000000, 9999999)}`;
/** Hora de Ecuador (UTC-5) en un día lejano propio de cada prueba. */
const ec = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00-05:00`);
const farDay = () =>
  new Date(Date.now() + randomInt(40, 900) * 86400000).toISOString().slice(0, 10);
const providers = {
  send: async () => ({ providerMessageId: `auto-bird-${randomUUID()}`, provider: 'BIRD' }),
  confirm: async () => {},
};

async function staff(role: 'TECHNICIAN' | 'ADMIN') {
  const user = await db.user.create({
    data: { name: `${role} Plazos`, phone: phone(), passwordHash: 'x', role },
  });
  const endpoint = `https://fcm.googleapis.com/fcm/send/${randomUUID()}`;
  await db.pushSubscription.create({
    data: {
      userId: user.id,
      endpoint,
      endpointHash: endpointHash(endpoint),
      p256dh: Buffer.from(webpush.generateVAPIDKeys().publicKey, 'base64url').toString('base64url'),
      auth: randomBytes(16).toString('base64url'),
      installationId: randomUUID(),
    },
  });
  return user;
}

test(
  'cancelación automática: sin técnico a tiempo, sin respuesta del cliente; respuesta o confirmación la salvan',
  { skip: !enabled },
  async (t) => {
    const controller = new BookingController();
    const contacts: string[] = [];
    const tech = await staff('TECHNICIAN');
    t.after(async () => {
      await db.appointment.deleteMany({ where: { contactPhone: { in: contacts } } });
      await db.user.delete({ where: { id: tech.id } });
    });
    const day = farDay();
    const book = async (hhmm: string, consent = true) => {
      const contact = phone();
      contacts.push(contact);
      const { appointmentId } = await controller.create(
        {
          start: ec(day, hhmm).toISOString(),
          name: 'Saúl Parra',
          phone: contact,
          request: 'Cambio de joystick PS5',
          whatsappConsent: consent,
        },
        req(),
      );
      return db.appointment.findUniqueOrThrow({ where: { id: appointmentId } });
    };
    const expire = (id: string, data: Record<string, Date>) =>
      db.appointment.update({ where: { id }, data });
    const past = new Date(Date.now() - 60000);

    // 1) Nadie la confirma a tiempo: se cancela sola, sin llamar a Cal.com, y avisa al cliente.
    const unconfirmed = await book('09:00');
    await expire(unconfirmed.id, { holdExpiresAt: past });
    const before = cancels.length;
    await sweepBookingHolds();
    let row = await db.appointment.findUniqueOrThrow({ where: { id: unconfirmed.id } });
    assert.equal(row.status, 'CANCELLED');
    assert.match(row.autoCancelReason ?? '', /ningún técnico/);
    assert.equal(cancels.length, before);
    assert.ok(
      await db.automationJob.findFirst({
        where: { appointmentId: row.id, kind: 'CANCELLED', status: 'PENDING' },
      }),
      'WhatsApp «cita cancelada» al cliente',
    );
    assert.equal(
      await db.appointmentActivity.count({
        where: { appointmentId: row.id, action: 'AUTO_CANCELLED' },
      }),
      1,
    );
    // El horario vuelve a estar libre: otro cliente puede tomarlo.
    const again = await book('09:00');
    assert.equal(again.status, 'PENDING_LOCATION');

    // 2) Sale el WhatsApp inicial: corre el plazo del cliente (2 h activas).
    const silent = await book('12:00');
    const initial = await db.automationJob.findFirstOrThrow({
      where: { appointmentId: silent.id, kind: 'INITIAL' },
    });
    await processJob(initial.id, providers);
    row = await db.appointment.findUniqueOrThrow({ where: { id: silent.id } });
    assert.ok(row.responseDueAt, 'plazo del cliente desde el envío');
    await expire(silent.id, { responseDueAt: past });
    await sweepBookingHolds();
    row = await db.appointment.findUniqueOrThrow({ where: { id: silent.id } });
    assert.equal(row.status, 'CANCELLED');
    assert.match(row.autoCancelReason ?? '', /no respondió/);

    // 3) El cliente escribe (cualquier mensaje): su plazo deja de correr y no se cancela.
    const answered = await book('15:00');
    await expire(answered.id, { responseDueAt: new Date(Date.now() + 3600000) });
    const provider = {
      name: 'TEST',
      parseWebhook: () => ({
        kind: 'MESSAGE',
        eventId: randomUUID(),
        providerMessageId: `msg-${randomUUID()}`,
        accountId: 'test',
        source: 'customer_live',
        direction: 'inbound',
        phone: answered.contactPhone,
        bsuid: null,
        type: 'text',
        text: 'Hola, mañana les envío la ubicación',
        occurredAt: new Date(),
        inReplyTo: null,
      }),
    };
    await receiveWhatsAppWebhook(provider as never, Buffer.from('{}'), {});
    const inbox = await db.whatsAppWebhook.findFirstOrThrow({
      where: { provider: 'TEST', status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
    });
    await processWhatsAppWebhook(inbox.id);
    row = await db.appointment.findUniqueOrThrow({ where: { id: answered.id } });
    assert.equal(row.responseDueAt, null);
    await sweepBookingHolds();
    assert.equal(
      (await db.appointment.findUniqueOrThrow({ where: { id: answered.id } })).status,
      'PENDING_LOCATION',
    );

    // 4) Un técnico la confirma: ya no vence aunque el plazo del cliente haya pasado.
    const saved = await book('18:00');
    await confirmAppointment({ ...tech, role: 'TECHNICIAN' } as StaffUser, saved.id);
    await expire(saved.id, { holdExpiresAt: past, responseDueAt: past });
    await sweepBookingHolds();
    assert.equal(
      (await db.appointment.findUniqueOrThrow({ where: { id: saved.id } })).status,
      'CONFIRMED',
    );

    // 5) Sin autorización de WhatsApp: nunca se le escribe, así que solo vence por técnico.
    const noConsent = await book('20:00', false);
    assert.equal(noConsent.responseDueAt, null);
    assert.ok(noConsent.holdExpiresAt);
  },
);

test(
  'reserva hecha directo en Cal.com: recibe plazo y, al vencer, se cancela también en Cal.com',
  { skip: !enabled },
  async (t) => {
    const uid = `direct-${randomUUID()}`;
    const contact = phone();
    const day = farDay();
    t.after(async () => {
      cancelFails = false;
      await db.appointment.deleteMany({ where: { contactPhone: contact } });
    });
    await receiveCalWebhook({
      triggerEvent: 'BOOKING_REQUESTED',
      createdAt: new Date().toISOString(),
      payload: {
        uid,
        eventTypeId: 626262,
        startTime: ec(day, '10:00').toISOString(),
        endTime: ec(day, '12:00').toISOString(),
        attendees: [{ name: 'Cliente Directo', phoneNumber: contact }],
        responses: {
          notes: { value: 'Mantenimiento PS5' },
          whatsappConsent: { value: true },
          attendeePhoneNumber: { value: contact },
        },
        status: 'PENDING',
        metadata: {},
      },
    });
    let row = await db.appointment.findUniqueOrThrow({ where: { calUid: uid } });
    assert.equal(row.holdExpiresAt, null);
    // El barrido le da su plazo desde ahora.
    await sweepBookingHolds();
    row = await db.appointment.findUniqueOrThrow({ where: { calUid: uid } });
    assert.ok(row.holdExpiresAt && row.holdExpiresAt > new Date());

    // Vence, pero Cal.com no responde: no se cancela y se reintenta en 10 min.
    await db.appointment.update({
      where: { id: row.id },
      data: { holdExpiresAt: new Date(Date.now() - 60000) },
    });
    cancelFails = true;
    await sweepBookingHolds();
    row = await db.appointment.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(row.status, 'PENDING_LOCATION');
    assert.ok(row.holdExpiresAt! > new Date());

    // Cal.com vuelve: se cancela allí y en Instafix; su webhook no avisa otra vez.
    cancelFails = false;
    await db.appointment.update({
      where: { id: row.id },
      data: { holdExpiresAt: new Date(Date.now() - 60000) },
    });
    await sweepBookingHolds();
    row = await db.appointment.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(row.status, 'CANCELLED');
    assert.ok(cancels.includes(uid));
    await receiveCalWebhook({
      triggerEvent: 'BOOKING_CANCELLED',
      createdAt: new Date().toISOString(),
      payload: { uid, eventTypeId: 626262 },
    });
    assert.equal(
      await db.automationJob.count({ where: { appointmentId: row.id, kind: 'CANCELLED' } }),
      1,
    );
  },
);

test(
  'avisos para confirmar: 10 min, 30 min y cada 30; última oportunidad también a administración; nada de noche',
  { skip: !enabled },
  async (t) => {
    const tech = await staff('TECHNICIAN');
    const admin = await staff('ADMIN');
    const contact = phone();
    const day = farDay();
    t.after(async () => {
      await db.notification.deleteMany({ where: { recipient: { in: [tech.id, admin.id] } } });
      await db.appointment.deleteMany({ where: { contactPhone: contact } });
      await db.user.deleteMany({ where: { id: { in: [tech.id, admin.id] } } });
    });
    // Reserva provisional creada a las 09H00 de un día lejano; vence a las 13H00.
    const startedAt = ec(day, '09:00');
    const appointment = await db.appointment.create({
      data: {
        title: 'Cambio de joystick PS5',
        device: 'PS5',
        startsAt: new Date(startedAt.getTime() + 3 * 86400000),
        endsAt: new Date(startedAt.getTime() + 3 * 86400000 + 7200000),
        address: '',
        technician: '',
        contactName: 'Saúl Parra',
        contactPhone: contact,
        source: 'INSTAFIX_API',
        holdStartedAt: startedAt,
        holdExpiresAt: ec(day, '13:00'),
      },
    });
    const rows = (userId: string) =>
      db.notification.findMany({
        where: { appointmentId: appointment.id, recipient: userId, kind: 'CONFIRMATION_REMINDER' },
        orderBy: { createdAt: 'asc' },
      });
    const at = (hhmm: string) => scheduleConfirmationReminders(ec(day, hhmm));

    await at('09:05');
    assert.equal((await rows(tech.id)).length, 0, 'antes de 10 min no hay aviso');
    await at('09:12');
    await at('09:14');
    assert.equal((await rows(tech.id)).length, 1, 'una sola vez por etapa');
    assert.equal((await rows(admin.id)).length, 0, 'administración solo en el último');
    const [first] = await rows(tech.id);
    assert.equal((first.data as { title: string }).title, 'Cita pendiente por confirmar');
    assert.match((first.data as { body: string }).body, /Confírmala antes de las 13H00/);
    await at('09:31');
    await at('10:01');
    assert.equal((await rows(tech.id)).length, 3);
    // A 30 min del vencimiento: última oportunidad, a técnicos y administración.
    await at('12:35');
    const last = (await rows(admin.id))[0];
    assert.equal((last.data as { title: string }).title, 'Última oportunidad: cita de Saúl');
    assert.equal((await rows(tech.id)).length, 4);

    // De noche no se programa nada.
    await db.appointment.update({
      where: { id: appointment.id },
      data: { holdExpiresAt: ec(day, '23:59') },
    });
    const count = (await rows(tech.id)).length;
    await at('22:30');
    assert.equal((await rows(tech.id)).length, count);

    // Confirmada antes de enviarse: el aviso pendiente se anula sin enviar.
    await db.appointment.update({
      where: { id: appointment.id },
      data: { status: 'CONFIRMED', assignedTechnicianId: tech.id },
    });
    await db.notification.update({
      where: { id: last.id },
      data: { data: { ...(last.data as object), scheduledFor: new Date() } },
    });
    assert.equal(await deliverNotification(last.id), 'CANCELLED');
  },
);
