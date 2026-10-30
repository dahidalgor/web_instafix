import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Request } from 'express';
import { hashPassword, newToken, tokenHash } from '../auth/security';
import { db } from '../database/client';
import { receiveCalWebhook } from '../integrations/cal-webhook';
import { WhatsAppAdminController } from '../whatsapp/admin.controller';
import { CAL_CONSENT_ISSUE } from '../whatsapp/consent';
import type { WhatsAppService } from '../whatsapp/whatsapp.service';

const enabled = process.env.INSTAFIX_INTEGRATION === '1';

async function person(role: 'ADMIN' | 'CUSTOMER') {
  const user = await db.user.create({
    data: {
      name: `${role} Autoriza`,
      phone: `+59393${randomInt(1000000, 9999999)}`,
      passwordHash: await hashPassword('clave-autoriza-123'),
      role,
      phoneVerifiedAt: new Date(),
    },
  });
  const token = newToken();
  await db.session.create({
    data: { userId: user.id, tokenHash: tokenHash(token), expiresAt: new Date(Date.now() + 6e5) },
  });
  const req = {
    headers: { origin: 'http://localhost:5173', cookie: `instafix_session=${token}` },
    socket: { remoteAddress: `10.7.${randomInt(0, 255)}.${randomInt(1, 254)}` },
  } as unknown as Request;
  return { user, req };
}
const status = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return 200;
  } catch (e) {
    return (e as { getStatus?: () => number }).getStatus?.() ?? 500;
  }
};

test(
  'reserva directa en Cal.com sin autorización: el admin la registra y sale el WhatsApp',
  { skip: !enabled },
  async (t) => {
    const saved = { ...process.env };
    process.env.CAL_EVENT_TYPE_ID = '987654329';
    const uid = `consent-${randomUUID()}`;
    const contact = `+59399${randomInt(1000000, 9999999)}`;
    const admin = await person('ADMIN');
    const customer = await person('CUSTOMER');
    t.after(async () => {
      const row = await db.appointment.findUnique({ where: { calUid: uid } });
      if (row) {
        await db.automationJob.deleteMany({ where: { appointmentId: row.id } });
        await db.appointment.delete({ where: { id: row.id } });
      }
      await db.integrationEvent.deleteMany({ where: { sourceId: uid } });
      await db.adminAction.deleteMany({ where: { actorId: admin.user.id } });
      await db.user.deleteMany({ where: { id: { in: [admin.user.id, customer.user.id] } } });
      process.env = saved;
    });
    const start = new Date(Date.now() + 3 * 86400000);
    // Página pública de Cal.com: sin la casilla ni la metadata de la web de Instafix.
    await receiveCalWebhook({
      triggerEvent: 'BOOKING_CREATED',
      createdAt: new Date().toISOString(),
      payload: {
        uid,
        eventTypeId: 987654329,
        startTime: start.toISOString(),
        endTime: new Date(start.getTime() + 3600000).toISOString(),
        attendees: [{ name: 'Saúl Prueba', phoneNumber: contact }],
        responses: { notes: { value: 'Cambio de joystick PS5' } },
      },
    });
    const booked = await db.appointment.findUniqueOrThrow({ where: { calUid: uid } });
    assert.equal(booked.automationIssue, CAL_CONSENT_ISSUE);
    assert.equal(booked.whatsappConsentAt, null);
    assert.equal(await db.automationJob.count({ where: { appointmentId: booked.id } }), 0);

    const controller = new WhatsAppAdminController({} as WhatsAppService);
    const overview = (await controller.status(admin.req)) as {
      issues: { id: string; needsConsent: boolean }[];
    };
    assert.equal(overview.issues.find((i) => i.id === booked.id)?.needsConsent, true);

    assert.equal(await status(controller.consent(booked.id, customer.req)), 403);
    assert.deepEqual(await controller.consent(booked.id, admin.req), { ok: true, queued: true });

    const after = await db.appointment.findUniqueOrThrow({ where: { id: booked.id } });
    assert.equal(after.automationIssue, null, 'el aviso desaparece de «necesitan atención»');
    assert.ok(after.whatsappConsentAt);
    const jobs = await db.automationJob.findMany({ where: { appointmentId: booked.id } });
    assert.deepEqual(
      jobs.map((j) => [j.kind, j.status, j.recipient]),
      [['INITIAL', 'PENDING', contact]],
    );
    assert.equal(
      await db.adminAction.count({
        where: { actorId: admin.user.id, action: 'WHATSAPP_CONSENT_RECORDED', target: booked.id },
      }),
      1,
    );
  },
);
