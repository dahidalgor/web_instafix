import { bookingCreateSchema } from '@instafix/contracts';
import { maskPhone, normalizePhone } from '@instafix/contracts/src/phone';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { CalSimulator } from '../dev/cal-simulator';
import {
  appointmentStatusFromCal,
  CalApiError,
  CAL_VERSIONS,
  cancelCalBooking,
  createCalBooking,
  findCalBookingForAppointment,
  getCalSlots,
  localDate,
  normalizeSlots,
  rescheduleCalBooking,
  zonedDayStartUtc,
} from '../integrations/cal-api';

test('phones are masked without revealing the full number', () => {
  assert.equal(maskPhone('+593984703819'), '+593 98 *** **19');
  assert.equal(normalizePhone('098 470 3819', 'EC'), '+593984703819');
  assert.equal(normalizePhone('+593 98-470-3819', 'EC'), '+593984703819');
  assert.equal(normalizePhone('123', 'EC'), null);
});

test('local day boundaries follow the service time zone', () => {
  assert.equal(
    zonedDayStartUtc('2026-10-21', 'America/Guayaquil').toISOString(),
    '2026-10-21T05:00:00.000Z',
  );
  assert.equal(localDate('2026-10-21T04:30:00Z', 'America/Guayaquil'), '2026-10-20');
});

test('slot responses are normalized to local days with start and end', () => {
  const days = normalizeSlots(
    {
      '2026-10-21': [
        { start: '2026-10-21T10:00:00.000-05:00', end: '2026-10-21T11:00:00.000-05:00' },
        { start: '2026-10-21T09:00:00.000-05:00' },
        'invalid',
      ],
    },
    'America/Guayaquil',
  );
  assert.deepEqual(days, {
    '2026-10-21': [
      { start: '2026-10-21T14:00:00.000Z', end: '2026-10-21T15:00:00.000Z' },
      { start: '2026-10-21T15:00:00.000Z', end: '2026-10-21T16:00:00.000Z' },
    ],
  });
});

test('Cal booking states map to appointment states, not repair states', () => {
  assert.equal(appointmentStatusFromCal('accepted'), 'CONFIRMED');
  assert.equal(appointmentStatusFromCal('pending'), 'PENDING_LOCATION');
  assert.equal(appointmentStatusFromCal('awaiting_host'), 'PENDING_LOCATION');
  assert.equal(appointmentStatusFromCal('cancelled'), 'CANCELLED');
});

test('booking input drops unknown fields such as a forged phone or userId', () => {
  const parsed = bookingCreateSchema.parse({
    requestKey: randomUUID(),
    start: '2026-10-21T14:00:00.000Z',
    customerRequest: 'Mi PS5 se apaga después de jugar unos minutos.',
    whatsappConsent: true,
    phone: '+593982222222',
    userId: randomUUID(),
  });
  assert.equal('phone' in parsed, false);
  assert.equal('userId' in parsed, false);
  assert.equal(
    bookingCreateSchema.safeParse({ ...parsed, customerRequest: 'corto' }).success,
    false,
  );
  assert.equal(bookingCreateSchema.safeParse({ ...parsed, whatsappConsent: false }).success, false);
});

let simulator: CalSimulator;
const saved = { ...process.env };
before(async () => {
  simulator = await new CalSimulator({ initialStatus: 'pending' }).start();
  Object.assign(process.env, {
    CAL_API_BASE_URL: simulator.url,
    CAL_API_KEY: simulator.options.apiKey,
    CAL_EVENT_TYPE_ID: String(simulator.options.eventTypeId),
  });
});
after(async () => {
  process.env = saved;
  await simulator.stop();
});

function nextWorkingDay() {
  for (let offset = 2; offset < 10; offset++) {
    const day = localDate(new Date(Date.now() + offset * 86400000), 'America/Guayaquil');
    if (new Date(`${day}T12:00:00Z`).getUTCDay() !== 0) return day;
  }
  throw new Error('sin día laborable');
}

test('the Cal client uses the documented versions and detects conflicts', async () => {
  const day = nextWorkingDay();
  const days = await getCalSlots({ startDate: day, endDate: day, timeZone: 'America/Guayaquil' });
  assert.ok(days[day]?.length, 'el simulador ofrece horarios');
  const slot = days[day][0];
  const attendee = {
    name: 'Prueba',
    email: 'prueba@example.com',
    phoneNumber: '+593984703819',
    timeZone: 'America/Guayaquil',
  };
  const fields = { notes: 'PS5: revisión' };
  const booking = await createCalBooking({
    start: slot.start,
    attendee,
    bookingFieldsResponses: fields,
    metadata: { instafixAppointmentId: '7f1c2e9a-1111-4a5b-9c3d-123456789abc' },
  });
  assert.equal(booking.status, 'pending');
  assert.equal(booking.start, slot.start);
  await assert.rejects(
    createCalBooking({ start: slot.start, attendee, bookingFieldsResponses: fields, metadata: {} }),
    (error: unknown) => error instanceof CalApiError && error.kind === 'REJECTED',
  );
  const again = await getCalSlots({ startDate: day, endDate: day, timeZone: 'America/Guayaquil' });
  assert.equal(again[day]?.some((s) => s.start === slot.start) ?? false, false);

  const found = await findCalBookingForAppointment({
    appointmentId: '7f1c2e9a-1111-4a5b-9c3d-123456789abc',
    start: new Date(slot.start),
    attendeeEmail: attendee.email,
  });
  assert.equal(found?.uid, booking.uid);

  const target = again[day].at(-1)!;
  const moved = await rescheduleCalBooking(booking.uid, target.start, 'prueba');
  assert.notEqual(moved.uid, booking.uid);
  await cancelCalBooking(moved.uid, 'prueba');
  assert.equal(simulator.bookings.get(moved.uid)?.status, 'cancelled');

  const versions = new Map(
    simulator.calls.map((c) => [
      `${c.method} ${c.path.split('/').slice(0, 2).join('/')}`,
      c.version,
    ]),
  );
  assert.equal(versions.get('GET /slots'), CAL_VERSIONS.slots);
  assert.equal(versions.get('POST /bookings'), CAL_VERSIONS.bookings);
  assert.equal(versions.get('GET /bookings'), CAL_VERSIONS.listBookings);
});

test('a lost response after a write is reported as uncertain, never as success', async () => {
  const day = nextWorkingDay();
  const slot = (await getCalSlots({ startDate: day, endDate: day, timeZone: 'America/Guayaquil' }))[
    day
  ][1];
  simulator.next.createFailure = 'timeout-after-create';
  await assert.rejects(
    createCalBooking({
      start: slot.start,
      attendee: {
        name: 'P',
        email: 'p@example.com',
        phoneNumber: '+593984703819',
        timeZone: 'UTC',
      },
      bookingFieldsResponses: { notes: 'x' },
      metadata: {},
    }),
    (error: unknown) => error instanceof CalApiError && error.kind === 'UNCERTAIN',
  );
});

test('a wrong API key is rejected without exposing it', async () => {
  process.env.CAL_API_KEY = 'cal_wrong_key_value';
  try {
    await assert.rejects(
      getCalSlots({ startDate: nextWorkingDay(), endDate: nextWorkingDay(), timeZone: 'UTC' }),
      (error: unknown) =>
        error instanceof CalApiError && !error.message.includes('cal_wrong_key_value'),
    );
  } finally {
    process.env.CAL_API_KEY = simulator.options.apiKey;
  }
});
