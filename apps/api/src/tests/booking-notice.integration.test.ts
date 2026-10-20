import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Request } from 'express';
import { BookingController } from '../booking/booking.controller';
import { dayIn, firstBookableDay } from '../integrations/cal-client';
import { setEmailProvider } from '../mail/email.service';

test('from tomorrow: the first slot of the next day is bookable even if it is under 24 h away', () => {
  const saved = process.env.BOOKING_MIN_DAYS_AHEAD;
  delete process.env.BOOKING_MIN_DAYS_AHEAD;
  try {
    // 18:00 en Ecuador: mañana a las 08:00 faltan 14 h y aun así es reservable.
    const evening = new Date('2026-10-20T23:00:00Z');
    assert.equal(firstBookableDay(evening), '2026-10-21');
    assert.ok(dayIn(new Date('2026-10-21T13:00:00Z')) >= firstBookableDay(evening));
    // 23:30 en Ecuador sigue siendo «hoy» (aunque en UTC ya sea el día siguiente).
    assert.equal(firstBookableDay(new Date('2026-10-21T04:30:00Z')), '2026-10-21');
    process.env.BOOKING_MIN_DAYS_AHEAD = '0';
    assert.equal(firstBookableDay(evening), '2026-10-20');
    process.env.BOOKING_MIN_DAYS_AHEAD = 'basura';
    assert.equal(firstBookableDay(evening), '2026-10-21');
  } finally {
    if (saved === undefined) delete process.env.BOOKING_MIN_DAYS_AHEAD;
    else process.env.BOOKING_MIN_DAYS_AHEAD = saved;
  }
});

test(
  'slots and bookings for a day before the first bookable day are rejected',
  { skip: process.env.INSTAFIX_INTEGRATION !== '1' },
  async (t) => {
    const saved = { ...process.env };
    // Con 2 días, «mañana» hace el papel de «hoy»: la prueba no depende de la hora actual.
    Object.assign(process.env, {
      BOOKING_MIN_DAYS_AHEAD: '2',
      CAL_API_KEY: 'test-key',
      CAL_API_VERSION: '2026-02-25',
      CAL_EVENT_TYPE_ID: '424243',
      CAL_ATTENDEE_RELAY_EMAIL: 'reservas@instafix.ec',
      APPOINTMENT_EMAILS_ENABLED: 'false',
    });
    setEmailProvider({ name: 'TEST', send: async () => ({ messageId: null }) });
    const tomorrow = dayIn(new Date(Date.now() + 86400000));
    const after = dayIn(new Date(Date.now() + 2 * 86400000));
    const original = globalThis.fetch;
    let creates = 0;
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith('https://api.cal.com/')) return original(input, init);
      if (url.includes('/slots'))
        return Response.json({
          status: 'success',
          data: {
            [tomorrow]: [{ start: `${tomorrow}T12:00:00.000-05:00` }],
            [after]: [{ start: `${after}T08:00:00.000-05:00` }],
          },
        });
      if (url.endsWith('/bookings')) creates++;
      return Response.json({}, { status: 404 });
    }) as typeof fetch;
    t.after(() => {
      globalThis.fetch = original;
      process.env = saved;
    });
    const controller = new BookingController();
    const { days } = await controller.slots(tomorrow, after);
    assert.deepEqual(Object.keys(days), [after]);
    await assert.rejects(
      controller.create(
        {
          start: new Date(`${tomorrow}T12:00:00-05:00`).toISOString(),
          name: 'Cliente Pronto',
          email: `pronto-${randomUUID()}@example.com`,
          phone: `+59398${randomInt(1000000, 9999999)}`,
          request: 'PS5',
          whatsappConsent: true,
        },
        { headers: { origin: 'http://localhost:5173' } } as unknown as Request,
      ),
      (e: any) => e.getStatus() === 400 && e.getResponse().code === 'BOOKING_TOO_SOON',
    );
    assert.equal(creates, 0);
  },
);
