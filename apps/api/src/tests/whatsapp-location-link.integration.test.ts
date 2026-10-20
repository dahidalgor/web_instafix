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
