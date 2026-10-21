import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Request } from 'express';
import { SecurityController } from '../account/security.controller';
import { newToken, tokenHash } from '../auth/security';
import { VerificationService } from '../auth/verification.service';
import { db } from '../database/client';
import { receiveCalWebhook } from '../integrations/cal-webhook';
import { BirdWhatsAppProvider } from '../whatsapp/bird/bird.provider';
import type { WhatsAppOtpProvider } from '../whatsapp/otp.provider';
import { processWhatsAppWebhook, receiveWhatsAppWebhook } from '../whatsapp/webhook-inbox';
import { signedWebhook, webhookSecret } from './support/bird-webhooks';

const enabled = process.env.INSTAFIX_INTEGRATION === '1';
const phone = () => `+59399${randomInt(1000000, 9999999)}`;

test(
  'a Google Maps link sent by WhatsApp sets the appointment location (not from the business app)',
  { skip: !enabled },
  async (t) => {
    const prefix = `maps-${randomUUID()}`;
    const saved = { ...process.env };
    Object.assign(process.env, {
      CAL_EVENT_TYPE_ID: '987654323',
      WHATSAPP_ENABLED: 'false',
      BIRD_WEBHOOK_SECRET: webhookSecret,
      // El flujo real consultaría OpenStreetMap; aquí se prueba aparte con un fetch simulado.
      REVERSE_GEOCODING_ENABLED: 'false',
    });
    const provider = new BirdWhatsAppProvider();
    const ids: string[] = [];
    const phones: string[] = [];
    t.after(async () => {
      await db.appointment.deleteMany({ where: { calUid: { startsWith: prefix } } });
      await db.whatsAppWebhook.deleteMany({ where: { id: { in: ids } } });
      await db.whatsAppMessage.deleteMany({ where: { phone: { in: phones } } });
      await db.integrationEvent.deleteMany({ where: { sourceId: { in: phones } } });
      process.env = saved;
    });
    const start = new Date(Date.now() + 3 * 86400000);
    const book = async (contact: string) => {
      const uid = `${prefix}:${contact}`;
      await receiveCalWebhook({
        triggerEvent: 'BOOKING_REQUESTED',
        createdAt: new Date().toISOString(),
        payload: {
          uid,
          eventTypeId: 987654323,
          startTime: start.toISOString(),
          endTime: new Date(start.getTime() + 3600000).toISOString(),
          attendees: [{ name: 'Cliente Mapa', phoneNumber: contact }],
          responses: { servicio: { value: 'Laptop' }, whatsappConsent: { value: true } },
        },
      });
      return uid;
    };
    const text = async (contact: string, body: string, extra: Record<string, unknown> = {}) => {
      const id = `msg_${randomUUID()}`;
      ids.push(`BIRD:${id}`);
      const { raw, headers } = signedWebhook(
        webhookSecret,
        {
          type: 'whatsapp.received',
          timestamp: new Date().toISOString(),
          data: {
            whatsapp_id: `wam_${randomUUID()}`,
            workspace_id: 'ws',
            direction: 'inbound',
            from: { phone_number: contact },
            to: { phone_number: '+593984703819' },
            tags: null,
            metadata: null,
            text: { body },
            ...extra,
          },
        },
        id,
      );
      await receiveWhatsAppWebhook(provider, Buffer.from(raw), headers);
      await processWhatsAppWebhook(`BIRD:${id}`);
    };
    const appointment = (uid: string) =>
      db.appointment.findUniqueOrThrow({ where: { calUid: uid } });

    // Enlace con el pin del lugar: coordenadas exactas y nombre.
    const a = phone();
    phones.push(a);
    const first = await book(a);
    await text(a, 'Hola, buenas tardes');
    assert.equal((await appointment(first)).locationReceivedAt, null);
    await text(
      a,
      'Esta es mi casa https://www.google.com/maps/place/Edificio+Torres/@-0.18,-78.48,17z/data=!3d-0.1801234!4d-78.4805678',
    );
    const located = await appointment(first);
    assert.ok(located.locationReceivedAt);
    assert.equal(located.locationLatitude, -0.1801234);
    assert.equal(located.locationLongitude, -78.4805678);
    assert.equal(located.address, 'Edificio Torres');
    // Calle y sector desde las coordenadas (OpenStreetMap simulado; sin red en las pruebas).
    const { fillLocationArea } = await import('../whatsapp/location-area');
    process.env.REVERSE_GEOCODING_ENABLED = 'true';
    assert.equal(
      await fillLocationArea(located.id, async () =>
        Response.json({ address: { road: 'Av. Amazonas', suburb: 'La Carolina', city: 'Quito' } }),
      ),
      'Av. Amazonas · La Carolina, Quito',
    );
    assert.equal((await appointment(first)).locationArea, 'Av. Amazonas · La Carolina, Quito');
    // Ya calculado: no vuelve a consultar.
    assert.equal(
      await fillLocationArea(located.id, async () => {
        throw new Error('No debe consultar otra vez');
      }),
      'Av. Amazonas · La Carolina, Quito',
    );

    // Coordenadas escritas a mano.
    const b = phone();
    phones.push(b);
    const second = await book(b);
    await text(b, '-2.170998, -79.922359');
    assert.equal((await appointment(second)).locationLatitude, -2.170998);

    // El mismo enlace escrito desde la app Business (eco) no cuenta como del cliente.
    const c = phone();
    phones.push(c);
    const third = await book(c);
    await text(c, 'https://maps.google.com/?q=-0.2,-78.5', {
      direction: 'outbound',
      origin: 'business_app_echo',
      from: { phone_number: '+593984703819' },
      to: { phone_number: c },
    });
    assert.equal((await appointment(third)).locationReceivedAt, null);
  },
);

test(
  'a verified WhatsApp is never verified again (no code, no credit spent)',
  { skip: !enabled },
  async (t) => {
    const sent: string[] = [];
    const wa: WhatsAppOtpProvider = {
      name: 'TEST',
      async sendAuthenticationCode(to) {
        sent.push(to);
        return { messageId: `test-${randomUUID()}` };
      },
    };
    const user = await db.user.create({
      data: {
        name: 'Cuenta Verificada',
        phone: phone(),
        passwordHash: 'x',
        phoneVerifiedAt: new Date(),
      },
    });
    const token = newToken();
    await db.session.create({
      data: {
        userId: user.id,
        tokenHash: tokenHash(token),
        expiresAt: new Date(Date.now() + 60000),
      },
    });
    t.after(async () => {
      await db.phoneChallenge.deleteMany({ where: { phone: user.phone } });
      await db.user.delete({ where: { id: user.id } });
    });
    const req = {
      headers: { origin: 'http://localhost:5173', cookie: `instafix_session=${token}` },
    } as unknown as Request;
    await assert.rejects(
      new SecurityController(new VerificationService(wa)).startPhoneVerification(req),
      (e: any) => e.getStatus() === 409 && e.getResponse().code === 'PHONE_ALREADY_VERIFIED',
    );
    assert.equal(sent.length, 0);
    assert.equal(await db.phoneChallenge.count({ where: { phone: user.phone } }), 0);
  },
);

test(
  'location: reply to any message, no WhatsApp consent needed, a newer location corrects the old one',
  { skip: !enabled },
  async (t) => {
    const { receiveCustomerMessage } = await import('../whatsapp/inbound');
    const contact = phone();
    const startsAt = new Date(Date.now() + 2 * 86400000);
    const appointment = await db.appointment.create({
      data: {
        contactName: 'Cliente Sin Aviso',
        contactPhone: contact,
        // Sin autorización de avisos: aun así su ubicación sirve.
        whatsappConsentAt: null,
        title: 'Laptop',
        device: 'Laptop',
        startsAt,
        endsAt: new Date(startsAt.getTime() + 3600000),
        address: '',
        technician: '',
        source: 'INSTAFIX_API',
        locationRequestedAt: new Date(Date.now() - 60000),
      },
    });
    t.after(async () => {
      await db.appointment.delete({ where: { id: appointment.id } });
      await db.integrationEvent.deleteMany({ where: { sourceId: contact } });
    });
    const send = (id: string, latitude: number, secondsLater: number) =>
      receiveCustomerMessage({
        id: `${appointment.id}:${id}`,
        from: contact.slice(1),
        timestamp: String(Math.floor(Date.now() / 1000) + secondsLater),
        type: 'location',
        // Cita a un mensaje escrito desde la app Business (no es un aviso automático).
        context: { id: 'wam_mensaje_manual' },
        location: { latitude, longitude: -78.5 },
      });
    assert.equal(await send('a', -0.2, 5), appointment.id);
    assert.equal(
      (await db.appointment.findUniqueOrThrow({ where: { id: appointment.id } })).locationLatitude,
      -0.2,
    );
    // Corrección posterior: se actualiza.
    assert.equal(await send('b', -0.25, 20), appointment.id);
    assert.equal(
      (await db.appointment.findUniqueOrThrow({ where: { id: appointment.id } })).locationLatitude,
      -0.25,
    );
    // Una ubicación más antigua que la guardada no la sustituye.
    assert.equal(await send('c', -0.3, 10), null);
    assert.equal(
      (await db.appointment.findUniqueOrThrow({ where: { id: appointment.id } })).locationLatitude,
      -0.25,
    );
  },
);

test(
  'the technician can paste a Google Maps link or coordinates; other technicians cannot',
  { skip: !enabled },
  async (t) => {
    const { setLocation } = await import('../staff/staff-appointments.service');
    const saved = process.env.REVERSE_GEOCODING_ENABLED;
    process.env.REVERSE_GEOCODING_ENABLED = 'false';
    const tech = await db.user.create({
      data: { name: 'Técnico Mapa', phone: phone(), passwordHash: 'x', role: 'TECHNICIAN' },
    });
    const other = await db.user.create({
      data: { name: 'Otro Mapa', phone: phone(), passwordHash: 'x', role: 'TECHNICIAN' },
    });
    const startsAt = new Date(Date.now() + 2 * 86400000);
    const appointment = await db.appointment.create({
      data: {
        contactName: 'Cliente Pegado',
        contactPhone: phone(),
        title: 'PS5',
        device: 'PS5',
        startsAt,
        endsAt: new Date(startsAt.getTime() + 3600000),
        address: '',
        technician: 'Técnico Mapa',
        status: 'CONFIRMED',
        assignedTechnicianId: tech.id,
        source: 'INSTAFIX_API',
      },
    });
    t.after(async () => {
      process.env.REVERSE_GEOCODING_ENABLED = saved;
      await db.appointment.delete({ where: { id: appointment.id } });
      await db.user.deleteMany({ where: { id: { in: [tech.id, other.id] } } });
    });
    const asTech = { id: tech.id, role: 'TECHNICIAN', name: tech.name } as any;
    const result = await setLocation(
      asTech,
      appointment.id,
      'https://www.google.com/maps/place/Casa+Cliente/@-0.2,-78.5,17z/data=!3d-0.2012345!4d-78.5012345',
    );
    assert.equal(result.locationLatitude, -0.2012345);
    assert.equal(result.address, 'Casa Cliente');
    await assert.rejects(
      setLocation(asTech, appointment.id, 'hola'),
      (e: any) => e.getStatus() === 400,
    );
    await assert.rejects(
      setLocation(
        { id: other.id, role: 'TECHNICIAN', name: other.name } as any,
        appointment.id,
        '-0.1001, -78.4001',
      ),
      (e: any) => e.getStatus() === 403,
    );
  },
);
