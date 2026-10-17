import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bookingIdentity } from '../booking/booking-identity';

const owner = {
  id: 'account-a',
  name: 'Cliente Uno',
  phone: '+593984703819',
  email: 'one@example.com',
};
const input = {
  owner,
  invalidReference: false,
  ownerConflict: false,
  phone: owner.phone,
  email: owner.email,
  name: owner.name,
};

test('Cal fields cannot switch account ownership or the automation recipient', () => {
  const changed = bookingIdentity({ ...input, phone: '+593999123456', name: 'Otra persona' });
  assert.equal(changed.userId, owner.id);
  assert.equal(changed.contactPhone, owner.phone);
  assert.equal(changed.contactName, owner.name);
  assert.equal(changed.bookingIdentityIssue, 'PHONE_MISMATCH');
  assert.equal(
    bookingIdentity({ ...input, email: 'other@example.com' }).bookingIdentityIssue,
    'EMAIL_MISMATCH',
  );
});

test('national format and missing optional Cal fields do not discard authenticated ownership', () => {
  assert.equal(bookingIdentity({ ...input, phone: '0984703819' }).bookingIdentityIssue, null);
  assert.equal(bookingIdentity({ ...input, phone: undefined, email: undefined }).userId, owner.id);
  assert.equal(
    bookingIdentity({ ...input, phone: undefined, email: undefined }).contactPhone,
    owner.phone,
  );
  assert.equal(
    bookingIdentity({ ...input, phone: 'not-a-phone' }).bookingIdentityIssue,
    'PHONE_MISMATCH',
  );
});

test('an invalid reference is quarantined and a guest never acquires a registered account by phone', () => {
  assert.equal(
    bookingIdentity({ ...input, owner: null, invalidReference: true }).bookingIdentityIssue,
    'INVALID_REFERENCE',
  );
  assert.equal(bookingIdentity({ ...input, owner: null }).userId, null);
  assert.equal(
    bookingIdentity({ ...input, ownerConflict: true }).bookingIdentityIssue,
    'OWNER_CONFLICT',
  );
});
