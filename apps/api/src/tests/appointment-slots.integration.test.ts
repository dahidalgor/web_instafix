import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { StaffUser } from '../auth/session';
import { adminReactivateBooking } from '../booking/booking.service';
import { db } from '../database/client';
import { endpointHash } from '../notifications/staff/web-push.channel';
import { appointmentSlots } from '../staff/appointment-slots';
import { addBusyBlocks } from '../staff/availability';
import { proposeReschedule } from '../staff/reschedule-proposal';

const enabled = process.env.INSTAFIX_INTEGRATION === '1';
const HOUR = 3600000;
// Un día propio, dentro de los 60 días en que se puede proponer.
const day = new Date(Date.now() + randomInt(10, 40) * 24 * HOUR).toISOString().slice(0, 10);
const at = (hhmm: string) => new Date(`${day}T${hhmm}:00-05:00`);
const visitUid = `slots-${randomUUID()}`;
const offered = ['09:00', '11:00', '13:00', '15:00', '17:00'].map((h) => at(h).toISOString());

// Cal.com simulado: ofrece cinco horarios ese día; la visita dura 2 h.
const original = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: RequestInit) => {
  const url = String(input);
  if (!url.startsWith('https://api.cal.com/')) return original(input, init);
  if (url.includes('/slots?')) {
    // Las 16:00 se cruzan con la visita de las 15:00: Cal.com solo las ofrece si se le dice que
    // esa reserva es la que se mueve.
    const own = new URL(url).searchParams.get('bookingUidToReschedule') === visitUid;
    const starts = own ? [...offered, at('16:00').toISOString()].sort() : offered;
    return Response.json({
      status: 'success',
      data: { [day]: starts.map((start) => ({ start })) },
    });
  }
  if (url.includes('/event-types/'))
    return Response.json({ status: 'success', data: { lengthInMinutes: 120 } });
  return Response.json({}, { status: 404 });
}) as typeof fetch;

const phone = () => `+59397${randomInt(1000000, 9999999)}`;
const local = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Guayaquil',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));

test(
  'calendario para mover una visita: solo horarios que luego se aceptan al guardar',
  { skip: !enabled },
  async (t) => {
    const saved = { ...process.env };
    Object.assign(process.env, {
      CAL_API_KEY: 'cal_test',
      CAL_API_VERSION: '2026-02-25',
      CAL_EVENT_TYPE_ID: '777000003',
    });
    const make = (name: string, role: 'TECHNICIAN' | 'ADMIN') =>
      db.user.create({
        data: { name, phone: phone(), passwordHash: 'x', role, phoneVerifiedAt: new Date() },
      });
    const carlos = await make('Carlos Calendario', 'TECHNICIAN');
    const admin = await make('Ada Calendario', 'ADMIN');
    const ids: string[] = [];
    t.after(async () => {
      await db.automationJob.deleteMany({ where: { appointmentId: { in: ids } } });
      await db.appointmentActivity.deleteMany({ where: { appointmentId: { in: ids } } });
      await db.notification.deleteMany({ where: { appointmentId: { in: ids } } });
      await db.appointment.deleteMany({ where: { id: { in: ids } } });
      await db.user.deleteMany({ where: { id: { in: [carlos.id, admin.id] } } });
      process.env = saved;
    });
    const visit = await db.appointment.create({
      data: {
        title: 'Mantenimiento PS5',
        device: 'PS5',
        startsAt: at('15:00'),
        endsAt: at('17:00'),
        address: 'Cumbayá',
        contactName: 'Saúl Parra',
        contactPhone: phone(),
        whatsappConsentAt: new Date(),
        status: 'CONFIRMED',
        source: 'INSTAFIX_API',
        calUid: visitUid,
        calStatus: 'accepted',
        assignedTechnicianId: carlos.id,
        technician: carlos.name,
        confirmedAt: new Date(),
      },
    });
    // Otro cliente tiene apartadas las 11:00 (reserva provisional).
    const held = await db.appointment.create({
      data: {
        title: 'Limpieza',
        device: 'PS4',
        startsAt: at('11:00'),
        endsAt: at('13:00'),
        address: '',
        contactName: 'Otra Persona',
        technician: '',
        contactPhone: phone(),
        status: 'PENDING_LOCATION',
        source: 'INSTAFIX_API',
      },
    });
    ids.push(visit.id, held.id);
    // Carlos tiene clases de 09:00 a 10:00 ese día.
    await addBusyBlocks(carlos.id, {
      label: 'Clases',
      repeat: 'ONCE',
      date: day,
      allDay: false,
      start: '09:00',
      end: '10:00',
    });
    const tech = { ...carlos, role: 'TECHNICIAN' } as StaffUser;
    const ada = { ...admin, role: 'ADMIN' } as StaffUser;
    const times = (result: { days: Record<string, string[]> }) =>
      (result.days[day] ?? []).map(local);

    // Propuesta de Carlos: sin su hora ocupada, sin la reserva ajena y sin la hora actual.
    const proposal = await appointmentSlots(tech, visit.id, {
      from: day,
      to: day,
      purpose: 'proposal',
    });
    assert.deepEqual(times(proposal), ['13:00', '16:00', '17:00']);
    // Administración: cualquier horario libre en la agenda…
    const move = await appointmentSlots(ada, visit.id, { from: day, to: day, purpose: 'move' });
    assert.deepEqual(times(move), ['09:00', '13:00', '16:00', '17:00']);
    // …y manteniendo a Carlos, también libre para él.
    const keep = await appointmentSlots(ada, visit.id, {
      from: day,
      to: day,
      purpose: 'move',
      technicianId: carlos.id,
    });
    assert.deepEqual(times(keep), ['13:00', '16:00', '17:00']);
    // Un técnico no ve el calendario de administración ni el de una visita ajena.
    await assert.rejects(appointmentSlots(tech, visit.id, { from: day, to: day, purpose: 'move' }));
    await assert.rejects(
      appointmentSlots(ada, visit.id, { from: day, to: day, purpose: 'proposal' }),
    );

    // Lo que ofrece el calendario se acepta al guardar.
    // Una hora más tarde, sobre su propio horario: se acepta al guardar.
    const later = at('16:00').toISOString();
    await proposeReschedule(tech, visit.id, later);
    const row = await db.appointment.findUniqueOrThrow({ where: { id: visit.id } });
    assert.equal(row.proposedStartsAt?.toISOString(), later);
  },
);

test(
  'administración reactiva una cita cancelada: vuelve a esperar técnico y se avisa',
  { skip: !enabled },
  async (t) => {
    const saved = { ...process.env };
    Object.assign(process.env, {
      CAL_API_KEY: 'cal_test',
      CAL_API_VERSION: '2026-02-25',
      CAL_EVENT_TYPE_ID: '777000003',
    });
    const admin = await db.user.create({
      data: {
        name: 'Ada Reactiva',
        phone: phone(),
        passwordHash: 'x',
        role: 'ADMIN',
        phoneVerifiedAt: new Date(),
      },
    });
    // Con un dispositivo registrado: los avisos del equipo solo van a quien puede recibirlos.
    const endpoint = `https://fcm.googleapis.com/fcm/send/${randomUUID()}`;
    await db.pushSubscription.create({
      data: {
        userId: admin.id,
        endpoint,
        endpointHash: endpointHash(endpoint),
        p256dh: 'p256dh-de-prueba',
        auth: 'auth-de-prueba',
        installationId: randomUUID(),
      },
    });
    const cancelled = await db.appointment.create({
      data: {
        title: 'Joystick PS5',
        device: 'PS5',
        startsAt: at('13:00'),
        endsAt: at('15:00'),
        address: 'Cumbayá',
        technician: '',
        contactName: 'Clienta Cancelada',
        contactPhone: phone(),
        whatsappConsentAt: new Date(),
        status: 'CANCELLED',
        source: 'INSTAFIX_API',
        autoCancelReason: 'Cancelada automáticamente: ningún técnico la confirmó a tiempo.',
        locationReceivedAt: new Date(),
        locationLatitude: -0.2,
        locationLongitude: -78.4,
      },
    });
    t.after(async () => {
      await db.automationJob.deleteMany({ where: { appointmentId: cancelled.id } });
      await db.appointmentActivity.deleteMany({ where: { appointmentId: cancelled.id } });
      await db.notification.deleteMany({ where: { appointmentId: cancelled.id } });
      await db.adminAction.deleteMany({ where: { actorId: admin.id } });
      await db.appointment.deleteMany({ where: { id: cancelled.id } });
      await db.pushSubscription.deleteMany({ where: { userId: admin.id } });
      await db.user.deleteMany({ where: { id: admin.id } });
      process.env = saved;
    });
    const ada = { ...admin, role: 'ADMIN' } as StaffUser;
    // Para reactivar, su propio horario (13:00) sí se ofrece.
    const slots = await appointmentSlots(ada, cancelled.id, {
      from: day,
      to: day,
      purpose: 'reactivate',
    });
    assert.ok((slots.days[day] ?? []).includes(at('13:00').toISOString()));

    const result = await adminReactivateBooking(admin.id, cancelled.id, at('13:00').toISOString());
    assert.equal(result.status, 'PENDING_LOCATION');
    const row = await db.appointment.findUniqueOrThrow({ where: { id: cancelled.id } });
    assert.equal(row.autoCancelReason, null);
    assert.ok(row.holdExpiresAt && row.holdExpiresAt > new Date(), 'plazo nuevo para confirmar');
    assert.ok(row.locationReceivedAt, 'conserva la ubicación');
    // Con ubicación: al cliente «tu visita es el …»; al equipo, la solicitud.
    const jobs = await db.automationJob.findMany({ where: { appointmentId: row.id } });
    assert.ok(jobs.some((j) => j.kind === 'RESCHEDULED' && j.status === 'PENDING'));
    assert.ok(!jobs.some((j) => j.kind === 'INITIAL'));
    assert.ok(
      await db.notification.findFirst({
        where: { appointmentId: row.id, kind: 'APPOINTMENT_REQUESTED' },
      }),
    );
    assert.ok(
      await db.appointmentActivity.findFirst({
        where: { appointmentId: row.id, action: 'REACTIVATED' },
      }),
    );
    // Una cita que no está cancelada no se «reactiva».
    await assert.rejects(adminReactivateBooking(admin.id, row.id, at('17:00').toISOString()));
  },
);
