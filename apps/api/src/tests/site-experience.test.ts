import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registrationSchema, normalizePersonName, loginSchema } from '@instafix/contracts';
import { slideSchema, visitSchema } from '@instafix/contracts/src/site';

test('names are normalized independently without changing phone-only login', () => {
  const parsed = registrationSchema.parse({
    firstName: '  JOSÉ   luis ',
    lastName: 'péREZ-muÑOZ',
    phone: '+593984703819',
    email: 'USER@example.com',
    password: 'test-password-1234',
  });
  assert.equal(parsed.firstName, 'José Luis');
  assert.equal(parsed.lastName, 'Pérez-Muñoz');
  assert.equal(normalizePersonName('o’NEILL'), 'O’Neill');
  assert.equal(registrationSchema.safeParse({ ...parsed, lastName: '' }).success, false);
  assert.equal(
    loginSchema.safeParse({ phone: parsed.phone, password: parsed.password }).success,
    true,
  );
});

test('site content and analytics reject unsafe URLs, PII and arbitrary page paths', () => {
  const slide = {
    label: 'PC',
    title: 'Nuestro trabajo',
    description: 'Una descripción del trabajo.',
    detail: '',
    position: 0,
    published: true,
    media: [],
  };
  assert.equal(slideSchema.safeParse(slide).success, true);
  assert.equal(
    slideSchema.safeParse({
      ...slide,
      media: [{ type: 'image', url: 'javascript:alert(1)', alt: '' }],
    }).success,
    false,
  );
  const visit = {
    id: '00000000-0000-4000-8000-000000000001',
    sessionId: '00000000-0000-4000-8000-000000000002',
    page: 'contacto',
    activeSeconds: 30,
  };
  assert.equal(visitSchema.safeParse(visit).success, true);
  assert.equal(visitSchema.safeParse({ ...visit, email: 'private@example.com' }).success, false);
  assert.equal(visitSchema.safeParse({ ...visit, page: 'cuenta?phone=123' }).success, false);
  assert.equal(visitSchema.safeParse({ ...visit, activeSeconds: -1 }).success, false);
});
