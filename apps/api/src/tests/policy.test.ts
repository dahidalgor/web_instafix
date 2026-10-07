import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expiration, parseRequest } from '../requests/request-policy';
const valid = {
  name: 'Ana Pérez',
  phone: '+593991234567',
  offeringId: 'ps5-maintenance',
  problem: 'La consola se calienta',
  consent: true,
};
test('guest needs neither email nor account', () =>
  assert.equal(parseRequest(valid).success, true));
test('rejects local phone without country code', () =>
  assert.equal(parseRequest({ ...valid, phone: '0991234567' }).success, false));
test('client cannot inject price or confirmed state', () => {
  assert.equal(parseRequest({ ...valid, priceMinor: 1 }).success, false);
  assert.equal(parseRequest({ ...valid, status: 'CONFIRMADA' }).success, false);
});
test('requires messaging consent', () =>
  assert.equal(parseRequest({ ...valid, consent: false }).success, false));
test('pending request expires after thirty minutes', () =>
  assert.equal(
    expiration(new Date('2026-09-30T12:00:00Z')).toISOString(),
    '2026-09-30T12:30:00.000Z',
  ));
