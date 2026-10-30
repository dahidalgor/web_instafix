import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Request } from 'express';
import { hashPassword, newToken, tokenHash } from '../auth/security';
import { db } from '../database/client';
import { AppointmentsController } from '../appointments/appointments.controller';
import { receiveCalWebhook } from '../integrations/cal-webhook';
import { WhatsAppAdminController } from '../whatsapp/admin.controller';
import { CAL_CONSENT_ISSUE } from '../whatsapp/consent';
import type { WhatsAppService } from '../whatsapp/whatsapp.service';

const enabled = process.env.INSTAFIX_INTEGRATION === '1';

async function person(role: 'ADMIN' | 'CUSTOMER' | 'TECHNICIAN', email?: string) {
  const user = await db.user.create({
    data: {
      name: `${role} Autoriza`,
      email,
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
/** Técnico con un dispositivo suscrito a avisos push (destinatario de «nueva solicitud»). */
async function technicianWithPush() {
  const { user } = await person('TECHNICIAN');
  await db.pushSubscription.create({
    data: {
      userId: user.id,
      endpointHash: randomUUID(),
      endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`,
      p256dh: 'clave',
      auth: 'auth',
      installationId: randomUUID(),
    },
  });
  return user;
}
async function cleanup(uid: string, userIds: string[]) {
  const row = await db.appointment.findUnique({ where: { calUid: uid } });
  if (row) {
    await db.notification.deleteMany({ where: { appointmentId: row.id } });
    await db.automationJob.deleteMany({ where: { appointmentId: row.id } });
    await db.integrationEvent.deleteMany({ where: { sourceId: row.id } });
    await db.appointment.delete({ where: { id: row.id } });
  }
  await db.integrationEvent.deleteMany({ where: { sourceId: uid } });
  await db.adminAction.deleteMany({ where: { actorId: { in: userIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
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
    const admin = await person('ADMIN');
    // El cliente ya tiene cuenta con ese teléfono verificado y un correo.
    const customer = await person('CUSTOMER', `saul-${randomUUID().slice(0, 8)}@example.com`);
    const contact = customer.user.phone;
    const tech = await technicianWithPush();
    t.after(async () => {
      await cleanup(uid, [admin.user.id, customer.user.id, tech.id]);
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
    assert.equal(await db.notification.count({ where: { appointmentId: booked.id } }), 0);
    assert.deepEqual(await controller.consent(booked.id, admin.req), {
      ok: true,
      queued: true,
      linked: true,
    });

    const after = await db.appointment.findUniqueOrThrow({ where: { id: booked.id } });
    assert.equal(after.automationIssue, null, 'el aviso desaparece de «necesitan atención»');
    assert.ok(after.whatsappConsentAt);
    // Flujo normal: cita en la cuenta del cliente, aviso a técnicos y correo de cita recibida.
    assert.equal(after.userId, customer.user.id);
    assert.equal(after.contactEmail, customer.user.email);
    const notices = await db.notification.findMany({ where: { appointmentId: booked.id } });
    assert.ok(
      notices.some(
        (n) =>
          n.channel === 'WEB_PUSH' && n.kind === 'APPOINTMENT_REQUESTED' && n.recipient === tech.id,
      ),
      'el técnico recibe «Nueva solicitud de cita»',
    );
    assert.ok(
      notices.some((n) => n.channel === 'EMAIL'),
      'correo de cita recibida al cliente',
    );
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

test(
  'casilla «autorizó WhatsApp» al editar una reserva de Cal.com: guarda, quita el aviso y envía',
  { skip: !enabled },
  async (t) => {
    const saved = { ...process.env };
    process.env.CAL_EVENT_TYPE_ID = '987654330';
    const uid = `consent-edit-${randomUUID()}`;
    const contact = `+59399${randomInt(1000000, 9999999)}`;
    const admin = await person('ADMIN');
    const tech = await technicianWithPush();
    t.after(async () => {
      await cleanup(uid, [admin.user.id, tech.id]);
      process.env = saved;
    });
    const start = new Date(Date.now() + 3 * 86400000);
    start.setUTCSeconds(0, 0);
    // Descripción larga (como las de la web, hasta 500): el formulario debe poder guardarla.
    const request = `Cambio de joystick PS5. ${'El análogo izquierdo se mueve solo. '.repeat(6)}`;
    await receiveCalWebhook({
      triggerEvent: 'BOOKING_CREATED',
      createdAt: new Date().toISOString(),
      payload: {
        uid,
        eventTypeId: 987654330,
        startTime: start.toISOString(),
        endTime: new Date(start.getTime() + 3600000).toISOString(),
        attendees: [{ name: 'Saúl Prueba', phoneNumber: contact }],
        responses: { notes: { value: request } },
      },
    });
    const item = await db.appointment.findUniqueOrThrow({ where: { calUid: uid } });
    assert.equal(item.automationIssue, CAL_CONSENT_ISSUE);
    // Lo mismo que envía el formulario de Administración al marcar la casilla y guardar.
    const form = {
      userId: item.userId,
      contactName: item.contactName,
      contactPhone: item.contactPhone,
      whatsappConsent: true,
      title: item.title,
      device: item.device,
      startsAt: item.startsAt.toISOString(),
      endsAt: item.endsAt.toISOString(),
      timeZone: item.timeZone,
      address: item.address,
      technician: item.technician,
      status: item.status,
    };
    await new AppointmentsController().editAppointment(item.id, form, admin.req);
    const after = await db.appointment.findUniqueOrThrow({ where: { id: item.id } });
    assert.ok(after.whatsappConsentAt);
    assert.equal(after.automationIssue, null);
    assert.equal(after.userId, null, 'sin cuenta con ese teléfono: sigue como invitado');
    assert.equal(
      await db.notification.count({
        where: { appointmentId: item.id, channel: 'WEB_PUSH', recipient: tech.id },
      }),
      1,
    );
    const jobs = await db.automationJob.findMany({ where: { appointmentId: item.id } });
    assert.deepEqual(
      jobs.map((j) => [j.kind, j.status]),
      [['INITIAL', 'PENDING']],
    );
    // Guardar otra vez sin cambios no duplica el mensaje.
    await new AppointmentsController().editAppointment(item.id, form, admin.req);
    assert.equal(
      await db.automationJob.count({ where: { appointmentId: item.id, status: 'PENDING' } }),
      1,
    );
    assert.equal(
      await db.notification.count({ where: { appointmentId: item.id, channel: 'WEB_PUSH' } }),
      1,
      'guardar otra vez no repite el aviso al técnico',
    );
  },
);
