import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Request } from 'express';
import { BookingController } from '../booking/booking.controller';
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
const day = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
const ec = (hhmm: string) => `${day}T${hhmm}:00.000-05:00`;
let offered = [ec('09:00'), ec('12:30'), ec('16:45')];
type Call = { url: string; method: string; body: any };
const calls: Call[] = [];
let createReply: (call: Call) => Response = (call) =>
  Response.json({
    status: 'success',
    data: {
      uid: `uid-${randomUUID()}`,
      status: 'pending',
      start: call.body.start,
      end: new Date(new Date(call.body.start).getTime() + 3600000).toISOString(),
    },
  });
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
        const create = calls.find((c) => c.url.endsWith('/bookings'))!;
        assert.equal(new Date(create.body.start).getTime(), new Date(start).getTime());
        // La revalidación consultó la disponibilidad real del día de Ecuador.
        assert.ok(calls.some((c) => c.url.includes('/slots') && c.url.includes(`start=${day}`)));
      }
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

test(
  'Cal.com rejects and the slot is gone afterwards (race): SLOT_UNAVAILABLE',
  { skip: !enabled },
  async () => {
    createReply = () => {
      offered = [ec('09:00')];
      return Response.json(
        { status: 'error', error: { message: 'Slot no longer available' } },
        { status: 400 },
      );
    };
    try {
      await assert.rejects(book(`${day}T17:30:00.000Z`), (e) => {
        assert.deepEqual(error(e), { status: 409, code: 'SLOT_UNAVAILABLE' });
        return true;
      });
    } finally {
      offered = [ec('09:00'), ec('12:30'), ec('16:45')];
    }
  },
);

test(
  'configuration errors are never reported as an occupied slot',
  { skip: !enabled },
  async () => {
    // Clave de API inválida: /slots es público y sigue funcionando, crear la reserva no.
    createReply = () =>
      Response.json({ status: 'error', error: { message: 'Invalid API key' } }, { status: 401 });
    await assert.rejects(book(`${day}T14:00:00.000Z`), (e) => {
      assert.deepEqual(error(e), { status: 503, code: 'BOOKING_CONFIG' });
      return true;
    });
    // Campo obligatorio ausente en el tipo de evento: el horario sigue libre.
    createReply = () =>
      Response.json(
        {
          status: 'error',
          error: { message: 'Missing required booking field: title (cliente@example.com)' },
        },
        { status: 400 },
      );
    const logs: string[] = [];
    const warn = console.warn;
    console.warn = (line: string) => logs.push(line);
    try {
      await assert.rejects(book(`${day}T14:00:00.000Z`), (e) => {
        assert.deepEqual(error(e), { status: 502, code: 'BOOKING_REJECTED' });
        return true;
      });
    } finally {
      console.warn = warn;
    }
    const logged = logs.join('\n');
    assert.match(logged, /booking\.cal_rejected/);
    assert.match(logged, /Missing required booking field: title/);
    // El motivo se registra sin datos personales ni la clave.
    assert.equal(logged.includes('cliente@example.com'), false);
    assert.equal(logged.includes('test-key'), false);
  },
);
