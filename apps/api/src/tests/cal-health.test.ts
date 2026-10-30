import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calHealth } from '../integrations/cal-health';

/** Cal.com simulado: `slots` por día y `fields` del formulario del evento. */
function mockCal(slots: Record<string, { start: string }[]>, event: Record<string, unknown>) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/v2/slots'))
      return new Response(JSON.stringify({ status: 'success', data: slots }), { status: 200 });
    if (url.includes('/v2/event-types/'))
      return new Response(JSON.stringify({ status: 'success', data: event }), { status: 200 });
    throw new Error(`URL inesperada ${url}`);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}
const env = { CAL_API_KEY: 'cal_test', CAL_EVENT_TYPE_ID: '123' };
const now = new Date('2026-11-02T15:00:00Z');
const defaults = [
  { slug: 'name', required: true },
  { slug: 'attendeePhoneNumber', required: true },
  { slug: 'notes', required: true },
  { slug: 'email', required: false },
];

test('agenda sana: horarios, evento oculto solo como nota', async (t) => {
  Object.assign(process.env, env);
  t.after(
    mockCal(
      {
        '2026-11-03': [
          { start: '2026-11-03T09:00:00-05:00' },
          { start: '2026-11-03T10:00:00-05:00' },
        ],
      },
      { title: 'Agenda', hidden: true, bookingFields: defaults, minimumBookingNotice: 60 },
    ),
  );
  const health = await calHealth(now);
  assert.equal(health.ok, true);
  assert.equal(health.slots, 2);
  assert.deepEqual(health.problems, []);
  assert.ok(health.notes.some((n) => n.includes('oculto')));
});

test('sin horarios en 30 días: problema visible en Administración', async (t) => {
  Object.assign(process.env, env);
  t.after(mockCal({}, { title: 'Agenda', hidden: false, bookingFields: defaults }));
  const health = await calHealth(now);
  assert.equal(health.ok, false);
  assert.equal(health.slots, 0);
  assert.ok(health.problems[0].includes('ningún horario'));
});

test('campo obligatorio que la web no envía: avisa antes de que fallen las reservas', async (t) => {
  Object.assign(process.env, env);
  t.after(
    mockCal(
      { '2026-11-03': [{ start: '2026-11-03T09:00:00-05:00' }] },
      {
        title: 'Agenda',
        bookingFields: [
          ...defaults.slice(0, 3),
          { slug: 'email', required: true },
          { slug: 'whatsappConsent', type: 'checkbox', required: true },
          { slug: 'oculto', required: true, hidden: true },
        ],
        minimumBookingNotice: 1440,
      },
    ),
  );
  const health = await calHealth(now);
  assert.equal(health.ok, false);
  assert.equal(health.problems.length, 1);
  assert.ok(health.problems[0].includes('whatsappConsent'));
  assert.ok(health.notes.some((n) => n.includes('correo')));
  assert.ok(health.notes.some((n) => n.includes('24 h')));
});
