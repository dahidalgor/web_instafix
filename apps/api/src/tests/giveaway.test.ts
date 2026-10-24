import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  completeAppointmentSchema,
  giveaway,
  giveawayOpen,
  suggestedGiveawayEntries,
} from '@instafix/contracts';

test('giveaway accepts entries until the end of the draw day in Ecuador', () => {
  // 23:59 del día del sorteo en Ecuador (UTC-5) todavía cuenta; el día siguiente no.
  const lastMinute = new Date(`${giveaway.drawDate}T23:59:00-05:00`);
  assert.equal(giveawayOpen(lastMinute), true);
  assert.equal(giveawayOpen(new Date(lastMinute.getTime() + 2 * 60000)), false);
  assert.equal(giveawayOpen(new Date('2026-10-23T12:00:00-05:00')), true);
});

test('complete body: optional, integer and capped', () => {
  assert.deepEqual(completeAppointmentSchema.parse({}), { giveawayEntries: 0 });
  assert.equal(completeAppointmentSchema.parse({ giveawayEntries: 3 }).giveawayEntries, 3);
  for (const bad of [-1, 1.5, giveaway.maxEntries + 1, '2'])
    assert.equal(completeAppointmentSchema.safeParse({ giveawayEntries: bad }).success, false);
  assert.equal(
    completeAppointmentSchema.safeParse({ giveawayEntries: 1, extra: true }).success,
    false,
  );
});

test('suggestion counts PS5 / DualSense joystick pairs only', () => {
  const s = (nameSnapshot: string, deviceSnapshot: string, quantity = 1) => ({
    nameSnapshot,
    deviceSnapshot,
    quantity,
  });
  assert.equal(
    suggestedGiveawayEntries([
      s('Par de joysticks', 'PS5', 2),
      s('Par de Joysticks', 'PS4', 3),
      s('Cambio de Joystick', 'PS5'),
      s('Mantenimiento completo', 'PS5'),
      s('Par de joysticks', 'Mando DualSense'),
    ]),
    3,
  );
  // PS5 en el nombre del servicio (equipo genérico) también cuenta; PS4 no.
  assert.equal(suggestedGiveawayEntries([s('Par de Joysticks PS5', 'Mandos', 2)]), 2);
  assert.equal(suggestedGiveawayEntries([s('Par de joysticks PS4', 'Mandos', 2)]), 0);
  assert.equal(suggestedGiveawayEntries([]), 0);
});
