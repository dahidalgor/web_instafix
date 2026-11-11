import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Request } from 'express';
import { AppointmentsController } from '../appointments/appointments.controller';
import { hashPassword, newToken, tokenHash } from '../auth/security';
import { db } from '../database/client';

const enabled = process.env.INSTAFIX_INTEGRATION === '1';

type CalCall = { url: string; method: string; body: any };
const calls: CalCall[] = [];
let handler: (call: CalCall) => Response = () => Response.json({}, { status: 500 });
const original = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: RequestInit) => {
  const url = String(input);
  if (!url.startsWith('https://api.cal.com/')) return original(input, init);
  const call = {
    url,
    method: init?.method || 'GET',
    body: init?.body ? JSON.parse(String(init.body)) : null,
  };
  calls.push(call);
  return handler(call);
}) as typeof fetch;

async function person(role: 'ADMIN' | 'TECHNICIAN' | 'CUSTOMER') {
  const user = await db.user.create({
    data: {
      name: `${role} Reprograma`,
      phone: `+59393${randomInt(1000000, 9999999)}`,
      passwordHash: await hashPassword('clave-reprograma-123'),
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
    socket: { remoteAddress: `10.9.${randomInt(0, 255)}.${randomInt(1, 254)}` },
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
const at = (days: number, hourUtc: number) => {
  const d = new Date(Date.now() + days * 86400000);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d;
};

test(
  'administración cambia fecha y hora: se mueve en Cal.com, se avisa y se elige el técnico',
  { skip: !enabled },
  async (t) => {
    const saved = { ...process.env };
    Object.assign(process.env, {
      CAL_API_KEY: 'cal_test',
      CAL_API_VERSION: '2026-02-25',
      CAL_EVENT_TYPE_ID: '777000001',
    });
    const admin = await person('ADMIN');
    const tech = await person('TECHNICIAN');
    const customer = await person('CUSTOMER');
    const ids: string[] = [];
    t.after(async () => {
      await db.notification.deleteMany({ where: { appointmentId: { in: ids } } });
      await db.automationJob.deleteMany({ where: { appointmentId: { in: ids } } });
      await db.appointmentActivity.deleteMany({ where: { appointmentId: { in: ids } } });
      await db.integrationEvent.deleteMany({ where: { sourceId: { startsWith: 'adm-move-' } } });
      await db.appointment.deleteMany({ where: { id: { in: ids } } });
      await db.adminAction.deleteMany({ where: { actorId: admin.user.id } });
      await db.user.deleteMany({
        where: { id: { in: [admin.user.id, tech.user.id, customer.user.id] } },
      });
      process.env = saved;
    });
    const visit = async (data: Record<string, unknown>) => {
      const startsAt = at(5, 15);
      const row = await db.appointment.create({
        data: {
          title: 'Mantenimiento PS5',
          device: 'PS5',
          startsAt,
          endsAt: new Date(startsAt.getTime() + 7200000),
          address: '',
          contactName: 'Cliente Reprograma',
          contactPhone: `+59399${randomInt(1000000, 9999999)}`,
          contactEmail: `cliente-${randomUUID().slice(0, 6)}@example.com`,
          whatsappConsentAt: new Date(),
          status: 'CONFIRMED',
          assignedTechnicianId: tech.user.id,
          technician: tech.user.name,
          confirmedAt: new Date(),
          calStatus: 'accepted',
          ...data,
        },
      });
      ids.push(row.id);
      return row;
    };
    // Cal.com: reprogramar crea una reserva nueva pendiente; confirmarla la acepta.
    const confirmed = new Set<string>();
    handler = (call) => {
      const move = call.url.match(/\/bookings\/([^/]+)\/reschedule$/);
      if (move) {
        const start = new Date(call.body.start);
        return Response.json({
          status: 'success',
          data: {
            uid: `${decodeURIComponent(move[1])}-r`,
            status: 'pending',
            start: start.toISOString(),
            end: new Date(start.getTime() + 7200000).toISOString(),
          },
        });
      }
      const confirm = call.url.match(/\/bookings\/([^/]+)\/confirm$/);
      if (confirm) {
        confirmed.add(decodeURIComponent(confirm[1]));
        return Response.json({ status: 'success' });
      }
      const get = call.url.match(/\/bookings\/([^/?]+)$/);
      if (get)
        return Response.json({ status: 'success', data: { status: 'pending', uid: get[1] } });
      return Response.json({}, { status: 500 });
    };
    const controller = new AppointmentsController();
    const target = at(7, 19);

    // 1) Confirmada con técnico, se conserva al técnico.
    const kept = await visit({ calUid: `adm-move-${randomUUID()}` });
    assert.equal(
      await status(
        controller.rescheduleAppointment(kept.id, { startsAt: target.toISOString() }, customer.req),
      ),
      403,
    );
    const result = await controller.rescheduleAppointment(
      kept.id,
      { startsAt: target.toISOString(), keepTechnician: true },
      admin.req,
    );
    assert.equal(result.kept, true);
    assert.equal(result.cal, 'SYNCED');
    const after = await db.appointment.findUniqueOrThrow({ where: { id: kept.id } });
    assert.equal(after.startsAt.getTime(), target.getTime());
    assert.equal(after.calUid, `${kept.calUid}-r`);
    assert.equal(after.status, 'CONFIRMED');
    assert.equal(after.assignedTechnicianId, tech.user.id);
    assert.equal(after.rescheduleCount, 1);
    assert.ok(confirmed.has(`${kept.calUid}-r`), 'Cal.com recibe la confirmación nueva');
    const jobs = await db.automationJob.findMany({
      where: { appointmentId: kept.id, status: 'PENDING' },
    });
    assert.ok(
      jobs.some((j) => j.kind === 'RESCHEDULED'),
      'WhatsApp «reprogramada»',
    );
    assert.ok(
      jobs.some((j) => j.kind === 'DAY_BEFORE'),
      'recordatorio para la fecha nueva',
    );
    assert.ok(
      await db.notification.findFirst({
        where: { appointmentId: kept.id, channel: 'EMAIL', kind: 'APPOINTMENT_RESCHEDULED' },
      }),
      'correo de cita reprogramada',
    );
    assert.equal(
      await db.adminAction.count({
        where: { actorId: admin.user.id, action: 'APPOINTMENT_RESCHEDULED', target: kept.id },
      }),
      1,
    );
    // Repetir con la misma hora no vuelve a mover ni avisar.
    const again = await controller.rescheduleAppointment(
      kept.id,
      { startsAt: target.toISOString() },
      admin.req,
    );
    assert.equal(again.unchanged, true);

    // 2) Sin conservar al técnico: vuelve a pendiente para que otro la tome.
    const freed = await visit({ calUid: `adm-move-${randomUUID()}` });
    const other = at(8, 20);
    const freedResult = await controller.rescheduleAppointment(
      freed.id,
      { startsAt: other.toISOString(), keepTechnician: false },
      admin.req,
    );
    assert.equal(freedResult.kept, false);
    const freedAfter = await db.appointment.findUniqueOrThrow({ where: { id: freed.id } });
    assert.equal(freedAfter.status, 'PENDING_LOCATION');
    assert.equal(freedAfter.assignedTechnicianId, null);
    // Sin técnico vuelve a ser reserva provisional: sale de Cal.com hasta que alguien confirme.
    assert.equal(freedAfter.calUid, null);
    assert.equal(freedAfter.startsAt.getTime(), other.getTime());
    assert.ok(freedAfter.holdExpiresAt);
    assert.ok(
      calls.some((c) => c.url.includes(`/bookings/${freed.calUid}/cancel`)),
      'la reserva vieja se cancela en Cal.com',
    );

    // 3) Cal.com rechaza el horario: la cita no cambia.
    const before = calls.length;
    handler = (call) =>
      call.url.includes('/slots')
        ? Response.json({ status: 'success', data: {} })
        : Response.json({ message: 'no disponible' }, { status: 400 });
    const rejected = await visit({ calUid: `adm-move-${randomUUID()}` });
    assert.equal(
      await status(
        controller.rescheduleAppointment(rejected.id, { startsAt: other.toISOString() }, admin.req),
      ),
      409,
    );
    assert.ok(calls.length > before);
    const unchanged = await db.appointment.findUniqueOrThrow({ where: { id: rejected.id } });
    assert.equal(unchanged.startsAt.getTime(), rejected.startsAt.getTime());
    assert.equal(unchanged.assignedTechnicianId, tech.user.id);

    // 4) Cita manual (sin Cal.com): se cambia en el formulario, no aquí.
    const manual = await visit({ calUid: null });
    assert.equal(
      await status(
        controller.rescheduleAppointment(manual.id, { startsAt: other.toISOString() }, admin.req),
      ),
      400,
    );
  },
);
