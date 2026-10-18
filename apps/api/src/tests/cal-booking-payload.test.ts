import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCalBooking } from '../integrations/cal-client';

/**
 * El tipo de evento de Cal.com exige `notes` («¿Qué trabajo requiere?») y rechaza campos que no
 * existen. Enviar `servicio`/`whatsappConsent` hizo que toda reserva se mostrara como «horario
 * ocupado»: este test impide volver a ese payload.
 */
test('Cal booking sends only fields the event type defines', async () => {
  const original = {
    fetch: globalThis.fetch,
    key: process.env.CAL_API_KEY,
    id: process.env.CAL_EVENT_TYPE_ID,
  };
  let sent: any;
  process.env.CAL_API_KEY = 'test';
  process.env.CAL_EVENT_TYPE_ID = '1';
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    sent = JSON.parse(String(init.body));
    return Response.json({
      data: {
        uid: 'u1',
        status: 'accepted',
        start: '2026-10-30T22:00:00.000Z',
        end: '2026-10-31T00:00:00.000Z',
      },
    });
  }) as typeof fetch;
  try {
    await createCalBooking({
      start: new Date('2026-10-30T22:00:00.000Z'),
      name: 'Cliente',
      email: 'citas@example.com',
      phone: '+593991234567',
      request: 'Mi PS5 se apaga',
      whatsappConsent: true,
      reference: 'ref',
    });
  } finally {
    globalThis.fetch = original.fetch;
    for (const [name, value] of [
      ['CAL_API_KEY', original.key],
      ['CAL_EVENT_TYPE_ID', original.id],
    ])
      if (value === undefined) delete process.env[name!];
      else process.env[name!] = value;
  }
  assert.deepEqual(Object.keys(sent.bookingFieldsResponses).sort(), [
    'attendeePhoneNumber',
    'notes',
  ]);
  assert.equal(sent.bookingFieldsResponses.notes, 'Mi PS5 se apaga');
  assert.equal(sent.metadata.instafixWhatsappConsent, 'true');
});
