import { helpRequestSchema } from '@instafix/contracts';
import { normalizePhone } from '@instafix/contracts/src/phone';
import assert from 'node:assert/strict';
import { test } from 'node:test';
const input = {
  name: 'Prueba Local',
  phone: '+593991234567',
  device: 'PS5',
  problem: 'Necesito orientación',
  consent: true,
};
test('advice needs no offering, appointment or price', () =>
  assert.equal(helpRequestSchema.safeParse(input).success, true));
test('advice cannot inject appointment status', () =>
  assert.equal(helpRequestSchema.safeParse({ ...input, status: 'CONFIRMADA' }).success, false));
test('normalizes Ecuador national format and strips trunk zero', () =>
  assert.equal(normalizePhone('099 123 4567', 'EC'), '+593991234567'));
test('Ecuador login numbers with and without leading zero identify the same account', () => {
  for (const number of ['984703819', '0984703819', '098 470 3819', '+593984703819']) {
    assert.equal(normalizePhone(number, 'EC'), '+593984703819');
  }
});
test('normalizes country selected by customer', () =>
  assert.equal(normalizePhone('612345678', 'ES'), '+34612345678'));
test('pasted international number keeps its country prefix', () =>
  assert.equal(normalizePhone('+34 612345678', 'EC'), '+34612345678'));
test('invalid phone is rejected', () => assert.equal(normalizePhone('123', 'EC'), null));
