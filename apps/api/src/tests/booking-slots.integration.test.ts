import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Request } from 'express';
import { BookingController } from '../booking/booking.controller';
import type { StaffUser } from '../auth/session';
import { confirmAppointment } from '../staff/staff-appointments.service';
import { db } from '../database/client';
import { setEmailProvider } from '../mail/email.service';

const enabled = process.env.INSTAFIX_INTEGRATION === '1';
Object.assign(process.env, {
  CAL_API_KEY: 'test-key',
  CAL_API_VERSION: '2026-02-25',
  CAL_EVENT_TYPE_ID: '424242',
  CAL_ATTENDEE_RELAY_EMAIL: 'reservas@instafix.ec',
  APPOINTMENT_EMAILS_ENABLED: 'false',
});
setEmailProvider({ name: 'TEST', send: async () => ({ messageId: null }) });

// Día futuro en Ecuador y horarios tal como los devuelve Cal.com: con desplazamiento -05:00.
// Día lejano y aleatorio: las reservas provisionales de otras pruebas no ocupan sus horarios.
const day = new Date(Date.now() + randomInt(30, 900) * 86400000).toISOString().slice(0, 10);
const ec = (hhmm: string) => `${day}T${hhmm}:00.000-05:00`;
let offered = [ec('09:00'), ec('12:30'), ec('16:45')];
type Call = { url: string; method: string; body: any };
const calls: Call[] = [];
const defaultReply = (call: Call) =>
  Response.json({
    status: 'success',
    data: {
      uid: `uid-${randomUUID()}`,
      status: 'pending',
      start: call.body.start,
      end: new Date(new Date(call.body.start).getTime() + 3600000).toISOString(),
    },
  });
let createReply: (call: Call) => Response = defaultReply;
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
  if (url.includes('/slots'))
    return Response.json({
      status: 'success',
      data: { [day]: offered.map((start) => ({ start })) },
    });
  if (url.endsWith('/bookings') && call.method === 'POST') return createReply(call);
  return Response.json({}, { status: 404 });
}) as typeof fetch;

const req = { headers: { origin: 'http://localhost:5173' } } as unknown as Request;
const phone = () => `+59398${randomInt(1000000, 9999999)}`;
const book = (start: string, contact = phone()) =>
  new BookingController().create(
    {
      start,
      name: 'Cliente Horarios',
      email: `slots-${randomUUID()}@example.com`,
      phone: contact,
      request: 'Mi PS5 se apaga',
      whatsappConsent: true,
    },
    req,
  );
const error = (e: any) => ({ status: e.getStatus?.(), code: e.getResponse?.().code });
const ecTime = (iso: string) =>
  new Intl.DateTimeFormat('es-EC', {
    timeZone: 'America/Guayaquil',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(iso));

test(
  'slots: the instant shown is the instant booked, in any offset format',
  { skip: !enabled },
  async () => {
    const controller = new BookingController();
    const phones: string[] = [];
    try {
      const { days } = await controller.slots(day, day);
      // La API entrega UTC; 16:45 de Ecuador = 21:45Z, mismo día.
      assert.deepEqual(days[day], [
        `${day}T14:00:00.000Z`,
        `${day}T17:30:00.000Z`,
        `${day}T21:45:00.000Z`,
      ]);
      assert.deepEqual(days[day].map(ecTime), ['09:00', '12:30', '16:45']);

      // Caso A, B y último horario: lo que el navegador recibe se puede reservar.
      for (const start of days[day]) {
        const contact = phone();
        phones.push(contact);
        calls.length = 0;
        const result = await book(start, contact);
        assert.equal(result.startsAt, start);
        assert.equal(ecTime(result.startsAt), ecTime(start));
        // Reserva provisional: el horario se guarda en Instafix, Cal.com no recibe nada aún.
        assert.equal(
          calls.some((c) => c.url.endsWith('/bookings')),
          false,
        );
        // La revalidación consultó la disponibilidad real del día de Ecuador.
        assert.ok(calls.some((c) => c.url.includes('/slots') && c.url.includes(`start=${day}`)));
      }
      // Los horarios reservados provisionalmente ya no se ofrecen a otros clientes.
      assert.equal((await controller.slots(day, day)).days[day], undefined);
    } finally {
      await db.appointment.deleteMany({ where: { contactPhone: { in: phones } } });
    }
  },
);

test(
  'slot really taken: rejected before calling Cal.com create, with SLOT_UNAVAILABLE',
  { skip: !enabled },
  async () => {
    offered = [ec('09:00'), ec('12:30')];
    calls.length = 0;
    try {
      await assert.rejects(book(`${day}T21:45:00.000Z`), (e) => {
        assert.deepEqual(error(e), { status: 409, code: 'SLOT_UNAVAILABLE' });
        return true;
      });
      assert.equal(
        calls.some((c) => c.url.endsWith('/bookings')),
        false,
      );
    } finally {
      offered = [ec('09:00'), ec('12:30'), ec('16:45')];
    }
  },
);

/** Agenda y confirma con un técnico: ahí es cuando Instafix llama a Cal.com. */
async function bookAndConfirm(start: string) {
  const contact = phone();
  const tech = await db.user.create({
    data: { name: 'Técnico Horarios', phone: phone(), passwordHash: 'x', role: 'TECHNICIAN' },
  });
  const { appointmentId } = await book(start, contact);
  const cleanup = async () => {
    await db.appointment.deleteMany({ where: { contactPhone: contact } });
    await db.user.delete({ where: { id: tech.id } });
  };
  return {
    appointmentId,
    cleanup,
    confirm: () => confirmAppointment({ ...tech, role: 'TECHNICIAN' } as StaffUser, appointmentId),
  };
}

test(
  'Cal.com rejects at confirmation and the slot is gone (race): 409 and the visit stays pending',
  { skip: !enabled },
  async () => {
    const visit = await bookAndConfirm(`${day}T17:30:00.000Z`);
    createReply = () => {
      offered = [ec('09:00')];
      return Response.json(
        { status: 'error', error: { message: 'Slot no longer available' } },
        { status: 400 },
      );
    };
    try {
      await assert.rejects(visit.confirm(), (e: any) => e.getStatus() === 409);
      const row = await db.appointment.findUniqueOrThrow({ where: { id: visit.appointmentId } });
      assert.equal(row.status, 'PENDING_LOCATION');
      assert.match(row.automationIssue ?? '', /ya no está libre en Cal\.com/);
    } finally {
      offered = [ec('09:00'), ec('12:30'), ec('16:45')];
      createReply = defaultReply;
      await visit.cleanup();
    }
  },
);

test(
  'configuration errors at confirmation are never reported as an occupied slot',
  { skip: !enabled },
  async () => {
    const visit = await bookAndConfirm(`${day}T14:00:00.000Z`);
    const logs: string[] = [];
    const warn = console.warn;
    console.warn = (line: string) => logs.push(line);
    try {
      // Clave de API inválida: /slots es público y sigue funcionando, crear la reserva no.
      createReply = () =>
        Response.json({ status: 'error', error: { message: 'Invalid API key' } }, { status: 401 });
      await assert.rejects(visit.confirm(), (e: any) => e.getStatus() === 503);
      // Campo obligatorio ausente en el tipo de evento: el horario sigue libre.
      createReply = () =>
        Response.json(
          {
            status: 'error',
            error: { message: 'Missing required booking field: title (cliente@example.com)' },
          },
          { status: 400 },
        );
      await assert.rejects(visit.confirm(), (e: any) => e.getStatus() === 503);
      const row = await db.appointment.findUniqueOrThrow({ where: { id: visit.appointmentId } });
      assert.equal(row.status, 'PENDING_LOCATION');
      assert.equal(row.automationIssue, null);
    } finally {
      console.warn = warn;
      createReply = defaultReply;
      await visit.cleanup();
    }
    const logged = logs.join('\n');
    assert.match(logged, /staff\.confirm_cal_rejected/);
    assert.match(logged, /Missing required booking field: title/);
    // El motivo se registra sin datos personales ni la clave.
    assert.equal(logged.includes('cliente@example.com'), false);
    assert.equal(logged.includes('test-key'), false);
  },
);
