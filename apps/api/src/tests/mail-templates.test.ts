import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codeEmail, appointmentEmail } from '../mail/templates';

test('authentication emails contain HTML and equivalent text without putting codes in URLs', () => {
  for (const purpose of ['REGISTER', 'RESET']) {
    const email = codeEmail('123456', purpose);
    assert.ok(email.text.includes('123456'));
    assert.ok(email.html.includes('123456'));
    assert.ok(email.html.includes('role="presentation"'));
    assert.ok(email.html.includes('max-width:600px'));
    assert.ok(email.html.includes('/images/instafix-logo.png'));
    assert.equal(/href="[^"]*123456/.test(email.html), false);
    assert.ok(email.text.includes('10 minutos'));
  }
  assert.throws(() => codeEmail('<script>', 'REGISTER'));
});
test('appointment preview escapes contact content and uses Ecuador time', () => {
  const email = appointmentEmail({
    name: '<img onerror=x>',
    description: 'Consola & mando',
    startsAt: new Date('2026-10-18T00:00:00Z'),
  });
  assert.ok(email.html.includes('&lt;img onerror=x&gt;'));
  assert.ok(email.html.includes('Consola &amp; mando'));
  assert.ok(email.text.includes('17 de octubre'));
  assert.ok(email.text.includes('19:00'));
});
