import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  addDays,
  blocksOn,
  localSpans,
  weekStartOf,
  busyBlockAt,
  busyBlockHours,
  busyBlockInputSchema,
  busyBlocksFromInput,
} from '@instafix/contracts';
import type { Request } from 'express';
import webpush from 'web-push';
import { newToken, tokenHash } from '../auth/security';
import { BookingController } from '../booking/booking.controller';
import { bookableSlots } from '../booking/booking.service';
import { db } from '../database/client';
import { setEmailProvider } from '../mail/email.service';
import { endpointHash, setPushSender } from '../notifications/staff/web-push.channel';
import { StaffController } from '../staff/staff.controller';
import { TeamController } from '../staff/team.controller';

const enabled = process.env.INSTAFIX_INTEGRATION === '1';
const vapid = webpush.generateVAPIDKeys();
Object.assign(process.env, {
  CAL_API_KEY: 'test-key',
  CAL_API_VERSION: '2026-02-25',
  CAL_EVENT_TYPE_ID: '737373',
  APPOINTMENT_EMAILS_ENABLED: 'false',
  VAPID_PUBLIC_KEY: vapid.publicKey,
  VAPID_PRIVATE_KEY: vapid.privateKey,
  VAPID_SUBJECT: 'mailto:avisos@instafix.ec',
});
setEmailProvider({ name: 'TEST', send: async () => ({ messageId: null }) });
setPushSender(async () => {});
const original = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: RequestInit) => {
  const url = String(input);
  if (!url.startsWith('https://api.cal.com/')) return original(input, init);
  if (url.endsWith('/bookings') && init?.method === 'POST') {
    const body = JSON.parse(String(init.body));
    return Response.json({
      status: 'success',
      data: {
        uid: `avail-${randomUUID()}`,
        status: 'accepted',
        start: body.start,
        end: new Date(new Date(body.start).getTime() + 7200000).toISOString(),
      },
    });
  }
  return Response.json({}, { status: 404 });
}) as typeof fetch;

/** Hora de Ecuador (UTC-5). */
const ec = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00-05:00`);
const phone = () => `+59390${randomInt(1000000, 9999999)}`;
/** Próximo lunes (fecha de Ecuador) al menos `weeks` semanas adelante. */
function monday(weeks: number) {
  const d = new Date(Date.now() - 5 * 3600000 + weeks * 7 * 86400000);
  d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7));
  return d.toISOString().slice(0, 10);
}

test('horarios ocupados: semanales, un día, todo el día y vigencia', () => {
  const parsed = busyBlockInputSchema.parse({
    label: 'Clases',
    repeat: 'WEEKLY',
    weekdays: [1, 3, 1],
    start: '08:00',
    end: '12:00',
    validUntil: '2027-02-28',
  });
  const blocks = busyBlocksFromInput(parsed, '2026-11-11');
  assert.equal(blocks.length, 2, 'un bloque por día, sin repetir');
  // Lunes 23 de noviembre de 2026.
  assert.equal(
    busyBlockAt(blocks, ec('2026-11-23', '10:00'), ec('2026-11-23', '12:00'))?.label,
    'Clases',
  );
  // Termina justo cuando empieza la clase: libre.
  assert.equal(busyBlockAt(blocks, ec('2026-11-23', '06:00'), ec('2026-11-23', '08:00')), null);
  assert.equal(busyBlockAt(blocks, ec('2026-11-23', '12:00'), ec('2026-11-23', '14:00')), null);
  // Martes: libre. Después del fin de semestre: libre.
  assert.equal(busyBlockAt(blocks, ec('2026-11-24', '09:00'), ec('2026-11-24', '11:00')), null);
  assert.equal(busyBlockAt(blocks, ec('2027-03-01', '09:00'), ec('2027-03-01', '11:00')), null);
  const once = busyBlocksFromInput(
    busyBlockInputSchema.parse({
      label: 'Médico',
      repeat: 'ONCE',
      date: '2026-11-26',
      allDay: true,
    }),
    '2026-11-11',
  );
  assert.equal(busyBlockHours(once[0]), 'Todo el día');
  assert.equal(busyBlockHours(blocks[0]), '08H00–12H00');
  assert.ok(busyBlockAt(once, ec('2026-11-26', '18:00'), ec('2026-11-26', '20:00')));
  // Visita que pasa de medianoche: se revisa también el día siguiente.
  assert.ok(busyBlockAt(once, ec('2026-11-25', '23:00'), ec('2026-11-26', '01:00')));
  // Datos inválidos.
  for (const body of [
    { label: 'X', repeat: 'ONCE', date: '2026-11-26', allDay: true },
    { label: 'Clases', repeat: 'WEEKLY', weekdays: [], allDay: true },
    { label: 'Clases', repeat: 'ONCE', date: '2026-11-26', start: '12:00', end: '08:00' },
    { label: 'Clases', repeat: 'ONCE', date: '2026-11-26', start: '25:00', end: '26:00' },
    { label: 'Clases', repeat: 'ONCE', date: '2026-11-26', allDay: true, userId: 'otro' },
  ])
    assert.equal(busyBlockInputSchema.safeParse(body).success, false);
});

test('calendario semanal: semanas de lunes a domingo, bloques por día y visitas por día', () => {
  // Miércoles 11 → lunes 9; domingo 15 → lunes 9; lunes 16 → lunes 16.
  assert.equal(weekStartOf('2026-11-11'), '2026-11-09');
  assert.equal(weekStartOf('2026-11-15'), '2026-11-09');
  assert.equal(weekStartOf('2026-11-16'), '2026-11-16');
  assert.equal(addDays('2026-12-30', 3), '2027-01-02');
  const blocks = [
    { weekday: 3, date: null, validFrom: '2026-11-01', validUntil: '2026-11-30', label: 'Clases' },
    { weekday: null, date: '2026-11-13', validFrom: null, validUntil: null, label: 'Médico' },
  ];
  assert.deepEqual(
    blocksOn(blocks, '2026-11-11').map((b) => b.label),
    ['Clases'],
  );
  assert.deepEqual(blocksOn(blocks, '2026-12-02'), [], 'fuera de vigencia');
  assert.deepEqual(
    blocksOn(blocks, '2026-11-13').map((b) => b.label),
    ['Médico'],
  );
  // Visita de 13H00 a 15H00 en Ecuador; una que pasa de medianoche da dos tramos.
  assert.deepEqual(localSpans(ec('2026-11-12', '13:00'), ec('2026-11-12', '15:00')), [
    { day: '2026-11-12', startMinute: 780, endMinute: 900 },
  ]);
  assert.deepEqual(localSpans(ec('2026-11-12', '23:00'), ec('2026-11-13', '01:00')), [
    { day: '2026-11-12', startMinute: 1380, endMinute: 1440 },
    { day: '2026-11-13', startMinute: 0, endMinute: 60 },
  ]);
});

test(
  'reparto por disponibilidad: solicitudes, pendientes y confirmación solo para técnicos libres; la web no ofrece horarios sin técnico',
  { skip: !enabled },
  async (t) => {
    const staff = new StaffController();
    const people: string[] = [];
    const contacts: string[] = [];
    // Solo el equipo de esta prueba: los demás técnicos y administradores se pausan mientras dura.
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
      await db.notification.deleteMany({ where: { recipient: { in: people } } });
      await db.appointment.deleteMany({ where: { contactPhone: { in: contacts } } });
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
    const student = await member('Carlos Estudiante');
    const free = await member('Ana Libre');
    const admin = await member('Admin Agenda', 'ADMIN');
    const day = monday(randomInt(8, 100));

    // Carlos tiene clases los lunes de 08H00 a 12H00.
    const saved = await staff.addBusy(
      { label: 'Clases', repeat: 'WEEKLY', weekdays: [1], start: '08:00', end: '12:00' },
      student.req,
    );
    assert.equal(saved.blocks.length, 1);
    assert.equal(saved.conflicts, 0);
    assert.equal((await staff.busy(free.req)).blocks.length, 0, 'cada técnico ve solo los suyos');
    // Nadie borra horarios ajenos.
    await staff.removeBusy(saved.blocks[0].id, free.req);
    assert.equal((await staff.busy(student.req)).blocks.length, 1);

    // Un cliente agenda el lunes a las 09H00.
    const contact = phone();
    contacts.push(contact);
    const { appointmentId } = await new BookingController().create(
      {
        start: ec(day, '09:00').toISOString(),
        name: 'Saúl Parra',
        phone: contact,
        request: 'Cambio de joystick PS5',
        whatsappConsent: true,
      },
      { headers: { origin: 'http://localhost:5173' } } as unknown as Request,
    );
    // El aviso de la solicitud llega a Ana y a administración, no a Carlos.
    const requested = await db.notification.findMany({
      where: { appointmentId, kind: 'APPOINTMENT_REQUESTED' },
    });
    const recipients = requested.map((n) => n.recipient);
    assert.ok(recipients.includes(free.user.id));
    assert.ok(recipients.includes(admin.user.id));
    assert.ok(!recipients.includes(student.user.id));

    // Carlos no la ve en pendientes ni puede confirmarla; Ana sí.
    assert.ok(!(await staff.pending(student.req)).some((a) => a.id === appointmentId));
    assert.ok((await staff.pending(free.req)).some((a) => a.id === appointmentId));
    const detail = await staff.detail(appointmentId, student.req);
    assert.equal(detail.busyReason, 'Clases');
    await assert.rejects(
      staff.confirm(appointmentId, student.req),
      (e: any) => e.getStatus() === 409 && /ocupado \(«Clases»\)|«Clases»/.test(e.message),
    );
    // Si Carlos quita su horario ocupado, ya puede.
    await staff.removeBusy(saved.blocks[0].id, student.req);
    assert.equal((await staff.detail(appointmentId, student.req)).busyReason, null);
    await staff.addBusy(
      { label: 'Clases', repeat: 'WEEKLY', weekdays: [1], start: '08:00', end: '12:00' },
      student.req,
    );
    await staff.confirm(appointmentId, free.req);

    // Administración también registra sus horarios (atiende visitas): los lunes en la mañana no.
    // Semana del equipo para Administración: cada persona con sus horarios y visitas.
    const team = new TeamController();
    assert.equal(
      await team.schedule(student.req, day).then(
        () => 200,
        (e: any) => e.getStatus(),
      ),
      403,
    );
    const week = await team.schedule(admin.req, day);
    assert.equal(week.weekStart, day, 'el lunes de esa semana');
    const carlosWeek = week.members.find((m) => m.id === student.user.id)!;
    assert.equal(carlosWeek.blocks[0].label, 'Clases');
    assert.equal(
      week.members.find((m) => m.id === free.user.id)!.visits[0].id,
      appointmentId,
      'la visita confirmada de Ana aparece en su semana',
    );
    await assert.rejects(team.schedule(admin.req, 'mañana'), (e: any) => e.getStatus() === 400);

    const meetings = await staff.addBusy(
      { label: 'Reuniones', repeat: 'WEEKLY', weekdays: [1], start: '08:00', end: '12:00' },
      admin.req,
    );
    assert.equal(meetings.blocks[0].label, 'Reuniones');

    // Ana ya tiene esa visita: no puede tomar otra que se cruce.
    const second = phone();
    contacts.push(second);
    await assert.rejects(
      new BookingController().create(
        {
          start: ec(day, '10:00').toISOString(),
          name: 'Otro Cliente',
          phone: second,
          request: 'Revisión',
          whatsappConsent: true,
        },
        { headers: { origin: 'http://localhost:5173' } } as unknown as Request,
      ),
      // Carlos en clase, Ana en otra visita y administración en reuniones: nadie podría.
      (e: any) => e.getStatus() === 409,
    );

    // La web no ofrece horarios en que nadie del equipo está libre.
    const slots = await bookableSlots({
      [day]: [ec(day, '09:00'), ec(day, '13:00'), ec(day, '15:00')].map((d) => d.toISOString()),
    });
    assert.deepEqual(slots[day], [ec(day, '13:00').toISOString(), ec(day, '15:00').toISOString()]);
    // Si Carlos agrega un nuevo horario sobre una visita ya confirmada, se le avisa.
    const conflict = await staff.addBusy(
      { label: 'Trabajo', repeat: 'ONCE', date: day, start: '08:00', end: '11:00' },
      free.req,
    );
    assert.equal(conflict.conflicts, 1);
  },
);
