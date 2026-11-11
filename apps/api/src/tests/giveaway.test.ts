import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  completeAppointmentSchema,
  giveawayInputSchema,
  giveawayIsOpen,
  suggestedGiveawayEntries,
} from '@instafix/contracts';

test('a giveaway accepts entries until the end of its draw day in Ecuador, unless closed', () => {
  const g = { drawDate: '2026-11-18', closedAt: null };
  // 23:59 del día del sorteo en Ecuador (UTC-5) todavía cuenta; el día siguiente no.
  const lastMinute = new Date('2026-11-18T23:59:00-05:00');
  assert.equal(giveawayIsOpen(g, lastMinute), true);
  assert.equal(giveawayIsOpen(g, new Date(lastMinute.getTime() + 2 * 60000)), false);
  assert.equal(giveawayIsOpen(g, new Date('2026-10-23T12:00:00-05:00')), true);
  // Cerrado a mano: ya no admite participaciones aunque falten días.
  assert.equal(
    giveawayIsOpen({ ...g, closedAt: '2026-11-11T15:00:00Z' }, new Date('2026-11-12T12:00:00Z')),
    false,
  );
});

test('complete body: optional, integer and capped', () => {
  assert.deepEqual(completeAppointmentSchema.parse({}), { giveawayEntries: 0 });
  assert.equal(completeAppointmentSchema.parse({ giveawayEntries: 3 }).giveawayEntries, 3);
  for (const bad of [-1, 1.5, 101, '2'])
    assert.equal(completeAppointmentSchema.safeParse({ giveawayEntries: bad }).success, false);
  assert.equal(
    completeAppointmentSchema.safeParse({ giveawayEntries: 1, extra: true }).success,
    false,
  );
});

test('suggestion counts only the services the giveaway includes', () => {
  const s = (offeringId: string | null, quantity = 1) => ({ offeringId, quantity });
  const eligible = ['par-joysticks-ps5', 'par-joysticks-xbox'];
  assert.equal(
    suggestedGiveawayEntries(
      [s('par-joysticks-ps5', 2), s('mantenimiento-ps5'), s('par-joysticks-xbox'), s(null, 3)],
      eligible,
    ),
    3,
  );
  assert.equal(suggestedGiveawayEntries([s('par-joysticks-ps5', 2)], []), 0);
  assert.equal(suggestedGiveawayEntries([], eligible), 0);
});

test('new giveaway: trimmed, defaults and limits', () => {
  const parsed = giveawayInputSchema.parse({
    prize: '  PlayStation 5 ',
    drawDate: '2027-01-15',
    entryRule: 'Una participación por cada servicio completado.',
  });
  assert.equal(parsed.prize, 'PlayStation 5');
  assert.equal(parsed.maxEntries, 20);
  assert.deepEqual(parsed.eligibleOfferingIds, []);
  assert.equal(giveawayInputSchema.safeParse({ ...parsed, drawDate: '15/01/2027' }).success, false);
});
