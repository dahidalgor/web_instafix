import { offeringSchema, registrationSchema } from '@instafix/contracts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hashPassword, newToken, tokenHash, verifyPassword } from '../auth/security';
test('password uses salt and rejects incorrect password', async () => {
  const a = await hashPassword('un-password-seguro');
  const b = await hashPassword('un-password-seguro');
  assert.notEqual(a, b);
  assert.equal(await verifyPassword('un-password-seguro', a), true);
  assert.equal(await verifyPassword('otro-password', a), false);
});
test('registration cannot self grant admin role', () =>
  assert.equal(
    registrationSchema.safeParse({
      name: 'Cliente',
      email: 'cliente@example.com',
      phone: '+593991234567',
      password: 'un-password-seguro',
      role: 'ADMIN',
    }).success,
    false,
  ));
test('session tokens are random and only hashes are stored', () => {
  const token = newToken();
  assert.notEqual(token, newToken());
  assert.notEqual(token, tokenHash(token));
});
const offering = {
  equipmentId: 'ps5',
  title: 'Mantenimiento básico',
  description: 'Descripción del servicio',
  priceMinor: 2500,
  durationMinutes: 60,
  warrantyDays: 0,
  availability: 'AVAILABLE',
  media: [],
};
test('catalog validates prices, states and unsafe media', () => {
  assert.equal(offeringSchema.safeParse(offering).success, true);
  assert.equal(offeringSchema.safeParse({ ...offering, priceMinor: -1 }).success, false);
  assert.equal(offeringSchema.safeParse({ ...offering, availability: 'invalid' }).success, false);
  assert.equal(
    offeringSchema.safeParse({
      ...offering,
      media: [{ type: 'image', url: 'javascript:alert(1)', alt: '' }],
    }).success,
    false,
  );
});

test('origin check: strict list in production, any local port in development', async () => {
  const { isAllowedOrigin } = await import('../config/environment');
  const env = { node: process.env.NODE_ENV, list: process.env.ALLOWED_ORIGINS };
  try {
    process.env.ALLOWED_ORIGINS = 'https://instafix.ec, https://admin.instafix.ec/';
    process.env.NODE_ENV = 'production';
    assert.equal(isAllowedOrigin('https://admin.instafix.ec'), true); // espacios y barra final
    assert.equal(isAllowedOrigin('http://localhost:5174'), false);
    assert.equal(isAllowedOrigin(undefined), false);
    process.env.NODE_ENV = 'development';
    assert.equal(isAllowedOrigin('http://localhost:5174'), true);
    assert.equal(isAllowedOrigin('http://127.0.0.1:5173'), true);
    assert.equal(isAllowedOrigin('http://localhost.evil.com'), false);
    assert.equal(isAllowedOrigin('https://evil.com'), false);
  } finally {
    process.env.NODE_ENV = env.node;
    process.env.ALLOWED_ORIGINS = env.list;
  }
});
