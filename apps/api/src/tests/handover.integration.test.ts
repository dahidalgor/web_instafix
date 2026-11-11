import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Request } from 'express';
import webpush from 'web-push';
import { AppointmentsController } from '../appointments/appointments.controller';
import { newToken, tokenHash } from '../auth/security';
import { db } from '../database/client';
import { setEmailProvider } from '../mail/email.service';
import { deliverNotification } from '../notifications/notification.service';
import { scheduleHandoverAlerts } from '../notifications/staff/staff-notifications';
import { endpointHash, setPushSender } from '../notifications/staff/web-push.channel';
import { StaffController } from '../staff/staff.controller';

const enabled = process.env.INSTAFIX_INTEGRATION === '1';
const vapid = webpush.generateVAPIDKeys();
Object.assign(process.env, {
  APPOINTMENT_EMAILS_ENABLED: 'true',
  VAPID_PUBLIC_KEY: vapid.publicKey,
  VAPID_PRIVATE_KEY: vapid.privateKey,
  VAPID_SUBJECT: 'mailto:avisos@instafix.ec',
});
setEmailProvider({ name: 'TEST', send: async () => ({ messageId: null }) });
setPushSender(async () => {});

const phone = () => `+59389${randomInt(1000000, 9999999)}`;
/** Hora de Ecuador (UTC-5). */
const ec = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00-05:00`);
const status = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return 200;
  } catch (e) {
    return (e as { getStatus?: () => number }).getStatus?.() ?? 500;
  }
};

test(
  'reemplazo: el técnico pide, otro libre la toma, el cliente recibe el correo; administración reasigna y recibe la alerta',
  { skip: !enabled },
  async (t) => {
    const staff = new StaffController();
    const admin = new AppointmentsController();
    const people: string[] = [];
    const ids: string[] = [];
    // Solo el equipo de esta prueba recibe avisos: los demás se pausan mientras dura.
    const others = await db.user.findMany({
      where: { role: { in: ['TECHNICIAN', 'ADMIN'] }, active: true },
      select: { id: true },
    });
    await db.user.updateMany({
      where: { id: { in: others.map((o) => o.id) } },
      data: { active: false },
    });
    t.after(async () => {
      await db.user.updateMany({
        where: { id: { in: others.map((o) => o.id) } },
        data: { active: true },
      });
      await db.notification.deleteMany({ where: { appointmentId: { in: ids } } });
      await db.appointmentActivity.deleteMany({ where: { appointmentId: { in: ids } } });
      await db.appointment.deleteMany({ where: { id: { in: ids } } });
      await db.adminAction.deleteMany({ where: { actorId: { in: people } } });
      await db.user.deleteMany({ where: { id: { in: people } } });
    });
    async function member(name: string, role: 'TECHNICIAN' | 'ADMIN' = 'TECHNICIAN') {
      const user = await db.user.create({
        data: { name, phone: phone(), passwordHash: 'x', role, phoneVerifiedAt: new Date() },
      });
      people.push(user.id);
      const token = newToken();
      await db.session.create({
        data: {
          userId: user.id,
          tokenHash: tokenHash(token),
          expiresAt: new Date(Date.now() + 6e5),
        },
      });
      const endpoint = `https://fcm.googleapis.com/fcm/send/${randomUUID()}`;
      await db.pushSubscription.create({
        data: {
          userId: user.id,
          endpoint,
          endpointHash: endpointHash(endpoint),
          p256dh: Buffer.from(webpush.generateVAPIDKeys().publicKey, 'base64url').toString(
            'base64url',
          ),
          auth: randomBytes(16).toString('base64url'),
          installationId: randomUUID(),
        },
      });
      const req = {
        headers: { origin: 'http://localhost:5173', cookie: `instafix_session=${token}` },
      } as unknown as Request;
      return { user, req };
    }
    const carlos = await member('Carlos Reemplazo');
    const ana = await member('Ana Reemplazo');
    const luis = await member('Luis Ocupado');
    const david = await member('David Admin', 'ADMIN');
    const day = new Date(Date.now() + randomInt(30, 300) * 86400000).toISOString().slice(0, 10);
    // Luis tiene clases ese día a esa hora.
    await db.technicianBusyBlock.create({
      data: { userId: luis.user.id, label: 'Clases', date: day, startMinute: 540, endMinute: 780 },
    });
    // Visita confirmada (aceptada antes) a cargo de Carlos, con su reserva de Cal.com.
    const visit = await db.appointment.create({
      data: {
        title: 'Cambio de joystick PS5',
        device: 'PS5',
        startsAt: ec(day, '10:00'),
        endsAt: ec(day, '12:00'),
        address: 'Cumbayá',
        contactName: 'Saúl Parra',
        contactPhone: phone(),
        contactEmail: `saul-${randomUUID().slice(0, 6)}@example.com`,
        status: 'CONFIRMED',
        calUid: `handover-${randomUUID()}`,
        calStatus: 'accepted',
        assignedTechnicianId: carlos.user.id,
        technician: carlos.user.name,
        confirmedAt: new Date(),
      },
    });
    ids.push(visit.id);
    const pushes = (kind: string) =>
      db.notification.findMany({ where: { appointmentId: visit.id, kind } });

    // Solo el técnico asignado puede pedir el reemplazo.
    assert.equal(await status(staff.handover(visit.id, {}, ana.req)), 403);
    assert.equal(
      await status(staff.handover(visit.id, { reason: 'x'.repeat(161) }, carlos.req)),
      400,
    );
    const asked = await staff.handover(visit.id, { reason: 'Imprevisto' }, carlos.req);
    assert.equal(asked.handover?.reason, 'Imprevisto');
    assert.equal(asked.assignedTechnician?.id, carlos.user.id, 'sigue a cargo mientras tanto');
    // El aviso llega a quienes están libres a esa hora: Ana y administración; no a Luis ni a Carlos.
    const offered = (await pushes('HANDOVER_REQUESTED')).map((n) => n.recipient).sort();
    assert.deepEqual(offered, [ana.user.id, david.user.id].sort());
    const offer = (await pushes('HANDOVER_REQUESTED'))[0];
    assert.match(
      (offer.data as { body: string }).body,
      /Carlos Reemplazo necesita un reemplazo para la visita de Saúl/,
    );

    // Ana la ve en Pendientes (sin el contacto del cliente); Luis no (está en clases).
    const forAna = (await staff.pending(ana.req)).find((a) => a.id === visit.id);
    assert.ok(forAna?.handover);
    assert.equal(forAna.contactPhone, '', 'el contacto llega al tomarla');
    assert.ok(!(await staff.pending(luis.req)).some((a) => a.id === visit.id));
    assert.equal(await status(staff.take(visit.id, luis.req)), 409);

    // Ana la toma: queda a su cargo, el cliente recibe el correo y Carlos el aviso.
    const taken = await staff.take(visit.id, ana.req);
    assert.equal(taken.assignedTechnician?.id, ana.user.id);
    assert.equal(taken.handover, null);
    assert.ok(taken.contactPhone, 'ahora ve el contacto');
    const row = await db.appointment.findUniqueOrThrow({ where: { id: visit.id } });
    assert.equal(row.technician, 'Ana Reemplazo');
    assert.equal(row.calUid, visit.calUid, 'Cal.com no cambia');
    assert.equal(row.status, 'CONFIRMED');
    assert.equal((await pushes('HANDOVER_TAKEN'))[0]?.recipient, carlos.user.id);
    assert.equal(
      (
        await db.notification.findMany({
          where: { appointmentId: visit.id, kind: 'APPOINTMENT_REASSIGNED' },
        })
      ).length,
      1,
      'correo al cliente con el técnico nuevo',
    );
    assert.ok(
      (await pushes('COMPLETION_REMINDER')).some((n) => n.recipient === ana.user.id),
      'los recordatorios de completar pasan a Ana',
    );
    // Las ofertas que quedaban pendientes se anulan al enviarse.
    const pendingOffer = (await pushes('HANDOVER_REQUESTED')).find((n) => n.status === 'PENDING');
    if (pendingOffer) assert.equal(await deliverNotification(pendingOffer.id), 'CANCELLED');
    // Ya no hay reemplazo abierto: nadie más la toma.
    assert.equal(await status(staff.take(visit.id, david.req)), 409);

    // Ana pide y luego retira el pedido: sigue a su cargo.
    await staff.handover(visit.id, {}, ana.req);
    const back = await staff.cancelHandover(visit.id, ana.req);
    assert.equal(back.handover, null);
    assert.equal(back.assignedTechnician?.id, ana.user.id);

    // Administración ve el equipo con su disponibilidad y la reasigna directamente.
    assert.equal(await status(admin.appointmentTeam(visit.id, ana.req)), 403);
    const team = await admin.appointmentTeam(visit.id, david.req);
    assert.equal(team.find((m) => m.id === luis.user.id)?.busyReason, 'Clases');
    assert.equal(team.find((m) => m.id === ana.user.id)?.current, true);
    assert.equal(
      await status(admin.reassignAppointment(visit.id, { technicianId: carlos.user.id }, ana.req)),
      403,
    );
    await admin.reassignAppointment(visit.id, { technicianId: carlos.user.id }, david.req);
    assert.equal(
      (await db.appointment.findUniqueOrThrow({ where: { id: visit.id } })).assignedTechnicianId,
      carlos.user.id,
    );
    assert.equal(
      (
        await db.notification.findMany({
          where: { appointmentId: visit.id, kind: 'APPOINTMENT_REASSIGNED' },
        })
      ).length,
      2,
    );
    assert.equal(
      await db.appointmentActivity.count({
        where: { appointmentId: visit.id, action: 'REASSIGNED' },
      }),
      2,
    );

    // Nadie toma el reemplazo y faltan menos de 24 h: alerta a administración (una vez).
    const now = ec(day, '10:00');
    const soon = await db.appointment.create({
      data: {
        title: 'Mantenimiento PS5',
        device: 'PS5',
        startsAt: new Date(now.getTime() + 20 * 3600000),
        endsAt: new Date(now.getTime() + 22 * 3600000),
        address: '',
        contactName: 'Paula',
        contactPhone: phone(),
        status: 'CONFIRMED',
        assignedTechnicianId: carlos.user.id,
        technician: carlos.user.name,
        handoverRequestedAt: new Date(now.getTime() - 2 * 3600000),
        handoverRequestedById: carlos.user.id,
      },
    });
    ids.push(soon.id);
    await scheduleHandoverAlerts(now);
    await scheduleHandoverAlerts(new Date(now.getTime() + 60000));
    const alerts = await db.notification.findMany({
      where: { appointmentId: soon.id, kind: 'HANDOVER_UNCLAIMED' },
    });
    assert.deepEqual(
      alerts.map((n) => n.recipient),
      [david.user.id],
    );
    assert.equal((alerts[0].data as { title: string }).title, 'Nadie tomó un reemplazo');
  },
);
