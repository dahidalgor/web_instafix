import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { parseStaffPushPayload } from '@instafix/contracts';
import webpush from 'web-push';
import type { StaffUser } from '../auth/session';
import { db } from '../database/client';
import { setEmailProvider } from '../mail/email.service';
import { deliverNotification } from '../notifications/notification.service';
import { scheduleCompletionReminders } from '../notifications/staff/staff-notifications';
import { endpointHash, setPushSender } from '../notifications/staff/web-push.channel';
import { confirmAppointment } from '../staff/staff-appointments.service';

const enabled = process.env.INSTAFIX_INTEGRATION === '1';
const vapid = webpush.generateVAPIDKeys();
Object.assign(process.env, {
  APPOINTMENT_EMAILS_ENABLED: 'false',
  VAPID_PUBLIC_KEY: vapid.publicKey,
  VAPID_PRIVATE_KEY: vapid.privateKey,
  VAPID_SUBJECT: 'mailto:avisos@instafix.ec',
});
setEmailProvider({ name: 'TEST', send: async () => ({ messageId: null }) });
const sent: { endpoint: string; body: string }[] = [];
setPushSender(async (subscription, body) => {
  sent.push({ endpoint: subscription.endpoint, body });
});

async function technician(name: string) {
  const user = await db.user.create({
    data: {
      name,
      phone: `+59394${randomInt(1000000, 9999999)}`,
      passwordHash: 'x',
      role: 'TECHNICIAN',
      phoneVerifiedAt: new Date(),
    },
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
  return { user, endpoint };
}
const reminders = (appointmentId: string) =>
  db.notification.findMany({
    where: { appointmentId, kind: 'COMPLETION_REMINDER' },
    orderBy: { dueAt: 'asc' },
  });
/** Adelanta un recordatorio a «ahora» (equivale a que pasen las horas). */
const due = (id: string) =>
  db.notification.update({ where: { id }, data: { dueAt: new Date(Date.now() - 1000) } });

test(
  'recordatorio al técnico para completar el trabajo: 2 h y 4 h después del fin',
  { skip: !enabled },
  async (t) => {
    const tech = await technician('Carlos Técnico');
    const other = await technician('Ana Técnica');
    const ids: string[] = [];
    t.after(async () => {
      setPushSender(null);
      await db.notification.deleteMany({ where: { appointmentId: { in: ids } } });
      await db.automationJob.deleteMany({ where: { appointmentId: { in: ids } } });
      await db.appointmentActivity.deleteMany({ where: { appointmentId: { in: ids } } });
      await db.appointment.deleteMany({ where: { id: { in: ids } } });
      await db.user.deleteMany({ where: { id: { in: [tech.user.id, other.user.id] } } });
    });
    const visit = async (startsAt: Date, data: Record<string, unknown> = {}) => {
      const row = await db.appointment.create({
        data: {
          title: 'Cambio de joystick PS5',
          device: 'PS5',
          startsAt,
          endsAt: new Date(startsAt.getTime() + 7200000),
          address: 'Cumbayá',
          technician: '',
          contactName: 'Saúl Parra',
          contactPhone: `+59399${randomInt(1000000, 9999999)}`,
          ...data,
        },
      });
      ids.push(row.id);
      return row;
    };
    const staff = tech.user as unknown as StaffUser;

    // 1) Al confirmar la cita se programan los dos recordatorios para el técnico que la tomó.
    const start = new Date(Date.now() + 2 * 86400000);
    start.setUTCHours(15, 0, 0, 0); // 10H00 en Ecuador
    const job = await visit(start);
    await confirmAppointment(staff, job.id);
    const [first, second] = await reminders(job.id);
    assert.equal(first.recipient, tech.user.id);
    assert.equal(first.dueAt.getTime(), job.endsAt.getTime() + 2 * 3600000);
    assert.equal(second.dueAt.getTime(), job.endsAt.getTime() + 4 * 3600000);
    // Antes de su hora no se envía.
    await deliverNotification(first.id);
    assert.equal(
      (await db.notification.findUniqueOrThrow({ where: { id: first.id } })).status,
      'PENDING',
    );
    // Confirmar otra vez (doble pulsación) no duplica los recordatorios.
    await confirmAppointment(staff, job.id);
    assert.equal((await reminders(job.id)).length, 2);

    // Primer recordatorio: llega solo al técnico asignado, con el mensaje propuesto.
    await due(first.id);
    assert.equal(await deliverNotification(first.id), 'SENT');
    const pushed = sent.filter((s) => s.endpoint === tech.endpoint);
    assert.equal(pushed.length, 1);
    assert.equal(sent.filter((s) => s.endpoint === other.endpoint).length, 0);
    const payload = parseStaffPushPayload(JSON.parse(pushed[0].body));
    assert.equal(payload.type, 'COMPLETION_REMINDER');
    assert.equal(payload.title, '¿Terminaste la visita de Saúl?');
    assert.equal(
      payload.body,
      'Marca como completado el trabajo de las 10H00 y registra los servicios realizados.',
    );
    assert.equal(payload.url, `/#cita=${job.id}`);

    // Lo completa antes del segundo: el segundo ya no se envía.
    await db.appointment.update({ where: { id: job.id }, data: { status: 'COMPLETED' } });
    await due(second.id);
    assert.equal(await deliverNotification(second.id), 'CANCELLED');
    assert.match(
      (await db.notification.findUniqueOrThrow({ where: { id: second.id } })).lastError ?? '',
      /completado/,
    );
    assert.equal(sent.filter((s) => s.endpoint === tech.endpoint).length, 1);

    // 2) Sigue sin completar: el segundo recordatorio sí llega, con su mensaje.
    const open = await visit(start, {
      status: 'IN_PROGRESS',
      assignedTechnicianId: tech.user.id,
      technician: tech.user.name,
    });
    await db.$transaction((tx) => scheduleCompletionReminders(tx, open));
    const [, last] = await reminders(open.id);
    await due(last.id);
    assert.equal(await deliverNotification(last.id), 'SENT');
    const final = parseStaffPushPayload(
      JSON.parse(sent.filter((s) => s.endpoint === tech.endpoint).at(-1)!.body),
    );
    assert.equal(final.title, 'Falta completar la visita de Saúl');
    assert.match(final.body, /sigue sin completar/);

    // 3) Reasignada a otro técnico o reprogramada: los recordatorios viejos se anulan.
    const moved = await visit(start, {
      status: 'CONFIRMED',
      assignedTechnicianId: tech.user.id,
      technician: tech.user.name,
    });
    await db.$transaction((tx) => scheduleCompletionReminders(tx, moved));
    const [movedFirst, movedSecond] = await reminders(moved.id);
    await db.appointment.update({
      where: { id: moved.id },
      data: { assignedTechnicianId: other.user.id },
    });
    await due(movedFirst.id);
    assert.equal(await deliverNotification(movedFirst.id), 'CANCELLED');
    await db.appointment.update({
      where: { id: moved.id },
      data: {
        assignedTechnicianId: tech.user.id,
        endsAt: new Date(moved.endsAt.getTime() + 86400000),
      },
    });
    await due(movedSecond.id);
    assert.equal(await deliverNotification(movedSecond.id), 'CANCELLED');
    assert.match(
      (await db.notification.findUniqueOrThrow({ where: { id: movedSecond.id } })).lastError ?? '',
      /reprogram/,
    );

    // 4) Confirmada tarde (el trabajo ya terminó hace 5 h): uno ya, el otro 2 h después.
    const now = new Date();
    const late = await visit(new Date(now.getTime() - 7 * 3600000), {
      status: 'CONFIRMED',
      assignedTechnicianId: tech.user.id,
      technician: tech.user.name,
    });
    await db.$transaction((tx) => scheduleCompletionReminders(tx, late, now));
    const [lateFirst, lateSecond] = await reminders(late.id);
    assert.equal(lateFirst.dueAt.getTime(), now.getTime());
    assert.equal(lateSecond.dueAt.getTime(), now.getTime() + 2 * 3600000);

    // 5) Sin técnico asignado no se programa nada.
    const unassigned = await visit(start, { status: 'CONFIRMED' });
    await db.$transaction((tx) => scheduleCompletionReminders(tx, unassigned));
    assert.equal((await reminders(unassigned.id)).length, 0);
  },
);
