import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Request } from 'express';
import { AccountController } from '../account/account.controller';
import { newToken, tokenHash } from '../auth/security';
import type { StaffUser } from '../auth/session';
import { db } from '../database/client';
import { staffAppointment } from '../staff/staff-appointments.service';
import { BirdWhatsAppProvider } from '../whatsapp/bird/bird.provider';
import { processWhatsAppWebhook, receiveWhatsAppWebhook } from '../whatsapp/webhook-inbox';
import { signedWebhook, webhookSecret } from './support/bird-webhooks';

/**
 * Flujo real de ubicación: webhook firmado de Bird → bandeja → worker → cita en PostgreSQL →
 * respuestas de Mi cuenta y del panel técnico. Sin red: geocodificación desactivada.
 */
const enabled = process.env.INSTAFIX_INTEGRATION === '1';
const BUSINESS = '+593984703819';
const phone = () => `+59396${randomInt(1000000, 9999999)}`;
const provider = new BirdWhatsAppProvider();
const webhookIds: string[] = [];
const appointmentIds: string[] = [];
const userIds: string[] = [];
const phones: string[] = [];
const saved = { ...process.env };

test.before(() => {
  Object.assign(process.env, {
    BIRD_WEBHOOK_SECRET: webhookSecret,
    REVERSE_GEOCODING_ENABLED: 'false',
  });
});
test.after(async () => {
  await db.whatsAppWebhook.deleteMany({ where: { id: { in: webhookIds } } });
  await db.appointment.deleteMany({ where: { id: { in: appointmentIds } } });
  await db.whatsAppMessage.deleteMany({ where: { phone: { in: phones } } });
  await db.integrationEvent.deleteMany({ where: { sourceId: { in: phones } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
  process.env = saved;
});

let clock = Date.now() - 600000;
/** Mensaje del cliente tal como lo entrega Bird (whatsapp.received), firmado. */
async function inbound(
  from: string,
  content: Record<string, unknown>,
  options: { id?: string; replyTo?: string } = {},
) {
  const deliveryId = options.id ?? `msg_${randomUUID()}`;
  const { raw, headers } = signedWebhook(
    webhookSecret,
    {
      type: 'whatsapp.received',
      timestamp: new Date((clock += 5000)).toISOString(),
      data: {
        whatsapp_id: `wam_${randomUUID()}`,
        workspace_id: 'ws',
        direction: 'inbound',
        from: { phone_number: from },
        to: { phone_number: BUSINESS },
        tags: null,
        metadata: null,
        ...(options.replyTo ? { in_reply_to_message_id: options.replyTo } : {}),
        ...content,
      },
    },
    deliveryId,
  );
  await receiveWhatsAppWebhook(provider, Buffer.from(raw), headers);
  webhookIds.push(`BIRD:${deliveryId}`);
  await processWhatsAppWebhook(`BIRD:${deliveryId}`);
  return { raw, headers, deliveryId };
}
const text = (from: string, body: string) => inbound(from, { text: { body } });
const pin = (from: string, latitude: number, longitude: number, extra = {}) =>
  inbound(from, { location: { latitude, longitude, ...extra } });

async function appointment(contactPhone: string, data: Record<string, unknown> = {}) {
  const startsAt = new Date(Date.now() + 2 * 86400000);
  const row = await db.appointment.create({
    data: {
      contactName: 'Cliente Ubicación',
      contactPhone,
      whatsappConsentAt: new Date(),
      title: 'Mantenimiento',
      device: 'Laptop',
      startsAt,
      endsAt: new Date(startsAt.getTime() + 3600000),
      address: '',
      technician: '',
      source: 'INSTAFIX_API',
      createdAt: new Date(Date.now() - 3600000),
      locationRequestedAt: new Date(Date.now() - 3600000),
      ...data,
    },
  });
  appointmentIds.push(row.id);
  return row;
}
const reload = (id: string) => db.appointment.findUniqueOrThrow({ where: { id } });
const outbound = (id: string) => db.automationJob.count({ where: { appointmentId: id } });

test(
  'case 1 + 2: text → "ok" → location: the "ok" does not cancel the wait; location saved',
  { skip: !enabled },
  async () => {
    const contact = phone();
    phones.push(contact);
    const a = await appointment(contact);
    await text(contact, 'Quiero agendar mantenimiento');
    await text(contact, 'ok');
    assert.equal((await reload(a.id)).locationReceivedAt, null);
    await pin(contact, -0.1807, -78.4678, { name: 'Casa', address: 'Av. Amazonas N24' });
    const saved = await reload(a.id);
    assert.equal(saved.locationLatitude, -0.1807);
    assert.equal(saved.locationLongitude, -78.4678);
    assert.equal(saved.locationSource, 'WHATSAPP');
    assert.equal(saved.locationName, 'Casa · Av. Amazonas N24');
    // La dirección escrita no se sustituye por la ubicación compartida.
    assert.equal(saved.address, '');
    assert.ok(saved.locationReceivedAt);
  },
);

test(
  '"ok" → location → "gracias": the appointment keeps the WhatsApp location (cases 3 and 9)',
  { skip: !enabled },
  async () => {
    const contact = phone();
    phones.push(contact);
    const a = await appointment(contact);
    const jobsBefore = await outbound(a.id);
    await text(contact, 'ok');
    await pin(contact, -0.2105, -78.4891);
    await text(contact, 'gracias');
    await text(contact, 'Es aquí 👍');
    // Imagen y sticker posteriores tampoco la tocan.
    await inbound(contact, { image: { mime_type: 'image/jpeg', caption: 'mi puerta' } });
    await inbound(contact, { sticker: { mime_type: 'image/webp' } });
    const kept = await reload(a.id);
    assert.equal(kept.locationLatitude, -0.2105);
    assert.equal(kept.locationLongitude, -78.4891);
    assert.equal(kept.locationSource, 'WHATSAPP');
    // Recibir la ubicación no genera ningún WhatsApp saliente.
    assert.equal(await outbound(a.id), jobsBefore);
    // Y sobrevive: Mi cuenta (otra lectura, como tras un refresh) la sigue devolviendo.
    const user = await db.user.create({
      data: { name: 'Dueño', phone: contact, passwordHash: 'x', phoneVerifiedAt: new Date() },
    });
    userIds.push(user.id);
    await db.appointment.update({ where: { id: a.id }, data: { userId: user.id } });
    const token = newToken();
    await db.session.create({
      data: {
        userId: user.id,
        tokenHash: tokenHash(token),
        expiresAt: new Date(Date.now() + 60000),
      },
    });
    const mine = await new AccountController().appointments({
      headers: { cookie: `instafix_session=${token}` },
    } as unknown as Request);
    const card = mine.find((x) => x.id === a.id)!;
    assert.equal(card.locationLatitude, -0.2105);
    assert.equal(card.locationLongitude, -78.4891);
    assert.ok(!('originIpHash' in card) && !('originSessionKey' in card));
  },
);

test('case 4: location A → text → location B: B replaces A', { skip: !enabled }, async () => {
  const contact = phone();
  phones.push(contact);
  const a = await appointment(contact);
  await pin(contact, -0.1, -78.4);
  await text(contact, 'Perdón, es aquí');
  await pin(contact, -0.12, -78.42);
  const updated = await reload(a.id);
  assert.equal(updated.locationLatitude, -0.12);
  assert.equal(updated.locationLongitude, -78.42);
  assert.equal(
    await db.integrationEvent.count({ where: { sourceId: contact, outcome: 'LOCATION_UPDATED' } }),
    1,
  );
});

test('case 5: a duplicated Bird webhook is processed once', { skip: !enabled }, async () => {
  const contact = phone();
  phones.push(contact);
  const a = await appointment(contact);
  const first = await pin(contact, -0.3, -78.5);
  const at = (await reload(a.id)).locationReceivedAt;
  // Bird reintenta el mismo webhook-id (mismo cuerpo y firma).
  await receiveWhatsAppWebhook(provider, Buffer.from(first.raw), first.headers);
  await processWhatsAppWebhook(`BIRD:${first.deliveryId}`);
  assert.equal(await db.whatsAppWebhook.count({ where: { id: `BIRD:${first.deliveryId}` } }), 1);
  assert.equal(
    await db.integrationEvent.count({
      where: { sourceId: contact, outcome: { startsWith: 'LOCATION' } },
    }),
    1,
  );
  assert.equal((await reload(a.id)).locationReceivedAt?.getTime(), at?.getTime());
  assert.equal(await outbound(a.id), 0);
});

test(
  'case 6 + 48: past A, active B waiting, future C → B only; never A, never C by guess',
  { skip: !enabled },
  async () => {
    const contact = phone();
    phones.push(contact);
    const day = 86400000;
    const past = await appointment(contact, {
      status: 'COMPLETED',
      startsAt: new Date(Date.now() - 5 * day),
      endsAt: new Date(Date.now() - 5 * day + 3600000),
    });
    const active = await appointment(contact, { status: 'CONFIRMED' });
    // C futura que ya tiene su ubicación: no espera otra.
    const later = await appointment(contact, {
      startsAt: new Date(Date.now() + 10 * day),
      endsAt: new Date(Date.now() + 10 * day + 3600000),
      locationLatitude: -0.5,
      locationLongitude: -78.6,
      locationReceivedAt: new Date(Date.now() - 2 * day),
      locationSource: 'WHATSAPP',
    });
    await text(contact, 'Hola');
    await pin(contact, -0.22, -78.51);
    assert.equal((await reload(active.id)).locationLatitude, -0.22);
    assert.equal((await reload(past.id)).locationLatitude, null);
    assert.equal((await reload(later.id)).locationLatitude, -0.5);

    // Dos citas esperando y ninguna pidió la ubicación: ambiguo, no se adivina.
    const other = phone();
    phones.push(other);
    const x = await appointment(other);
    const y = await appointment(other, {
      startsAt: new Date(Date.now() + 6 * day),
      endsAt: new Date(Date.now() + 6 * day + 3600000),
    });
    await pin(other, -0.4, -78.4);
    assert.equal((await reload(x.id)).locationLatitude, null);
    assert.equal((await reload(y.id)).locationLatitude, null);
    assert.match((await reload(x.id)).automationIssue ?? '', /Varias citas/);
    // La solicitud de ubicación enviada para Y (contexto de la conversación) la decide.
    await db.automationJob.create({
      data: {
        dedupeKey: `${y.id}:0:INITIAL`,
        appointmentId: y.id,
        revision: 0,
        kind: 'INITIAL',
        status: 'SENT',
        dueAt: new Date(),
        expiresAt: y.startsAt,
        startedAt: new Date(),
        providerMessageId: `wam_req_${randomUUID()}`,
      },
    });
    await pin(other, -0.41, -78.41);
    assert.equal((await reload(y.id)).locationLatitude, -0.41);
    assert.equal((await reload(x.id)).locationLatitude, null);
    // Citar el mensaje de una cita concreta la decide siempre.
    const job = await db.automationJob.create({
      data: {
        dedupeKey: `${x.id}:0:CONFIRMED`,
        appointmentId: x.id,
        revision: 0,
        kind: 'CONFIRMED',
        status: 'SENT',
        dueAt: new Date(),
        expiresAt: x.startsAt,
        startedAt: new Date(),
        providerMessageId: `wam_quoted_${randomUUID()}`,
      },
    });
    await inbound(
      other,
      { location: { latitude: -0.42, longitude: -78.42 } },
      { replyTo: job.providerMessageId! },
    );
    assert.equal((await reload(x.id)).locationLatitude, -0.42);
  },
);

test(
  'case 47: a cancelled appointment never receives later locations',
  { skip: !enabled },
  async () => {
    const contact = phone();
    phones.push(contact);
    const a = await appointment(contact, {
      status: 'CANCELLED',
      locationLatitude: -0.1,
      locationLongitude: -78.1,
      locationReceivedAt: new Date(Date.now() - 86400000),
    });
    await pin(contact, -0.9, -78.9);
    const kept = await reload(a.id);
    assert.equal(kept.locationLatitude, -0.1);
    assert.equal(
      await db.integrationEvent.count({
        where: { sourceId: contact, outcome: 'NO_MATCHING_APPOINTMENT' },
      }),
      1,
    );
  },
);

test(
  'case 8: invalid coordinates are rejected and the database is not modified',
  { skip: !enabled },
  async () => {
    const contact = phone();
    phones.push(contact);
    const a = await appointment(contact);
    await pin(contact, 123.4, -78.5);
    await pin(contact, -0.2, 200);
    const untouched = await reload(a.id);
    assert.equal(untouched.locationReceivedAt, null);
    assert.equal(untouched.locationLatitude, null);
    assert.equal(
      await db.integrationEvent.count({
        where: { sourceId: contact, outcome: 'INVALID_LOCATION' },
      }),
      2,
    );
    // Una firma falsa no llega a la bandeja.
    const forged = signedWebhook(
      'whsec_' + Buffer.from('otra-clave-0123456789abcdef').toString('base64'),
      {
        type: 'whatsapp.received',
        timestamp: new Date().toISOString(),
        data: {
          whatsapp_id: 'x',
          direction: 'inbound',
          from: { phone_number: contact },
          to: {},
          location: { latitude: -0.2, longitude: -78.5 },
        },
      },
    );
    await assert.rejects(
      receiveWhatsAppWebhook(provider, Buffer.from(forged.raw), forged.headers),
      (e: any) => e.getStatus() === 403,
    );
    assert.equal((await reload(a.id)).locationReceivedAt, null);
  },
);

test(
  'case 7: another customer or an unassigned technician cannot read the location',
  { skip: !enabled },
  async () => {
    const contact = phone();
    phones.push(contact);
    const owner = await db.user.create({
      data: { name: 'Dueña', phone: contact, passwordHash: 'x', phoneVerifiedAt: new Date() },
    });
    const stranger = await db.user.create({
      data: { name: 'Ajeno', phone: phone(), passwordHash: 'x', phoneVerifiedAt: new Date() },
    });
    const tech = await db.user.create({
      data: {
        name: 'Técnico Ajeno',
        phone: phone(),
        passwordHash: 'x',
        role: 'TECHNICIAN',
        phoneVerifiedAt: new Date(),
      },
    });
    userIds.push(owner.id, stranger.id, tech.id);
    const a = await appointment(contact, {
      userId: owner.id,
      locationLatitude: -0.19,
      locationLongitude: -78.49,
      locationReceivedAt: new Date(),
      locationSource: 'WHATSAPP',
      address: 'Casa de la dueña',
      locationArea: 'La Carolina, Quito',
    });
    const token = newToken();
    await db.session.create({
      data: {
        userId: stranger.id,
        tokenHash: tokenHash(token),
        expiresAt: new Date(Date.now() + 60000),
      },
    });
    const theirs = await new AccountController().appointments({
      headers: { cookie: `instafix_session=${token}` },
    } as unknown as Request);
    assert.ok(!theirs.some((x) => x.id === a.id));
    // Pendiente sin asignar: otro técnico ve el sector para decidir, nunca las coordenadas.
    const asTech = { ...tech, role: 'TECHNICIAN' } as unknown as StaffUser;
    const view = await staffAppointment(asTech, a.id);
    assert.equal(view.locationLatitude, null);
    assert.equal(view.address, '');
    assert.equal(view.locationArea, 'La Carolina, Quito');
    // Confirmada por otro técnico: 404 para el resto.
    await db.appointment.update({
      where: { id: a.id },
      data: { status: 'CONFIRMED', assignedTechnicianId: owner.id },
    });
    await assert.rejects(staffAppointment(asTech, a.id), (e: any) => e.getStatus() === 404);
  },
);
