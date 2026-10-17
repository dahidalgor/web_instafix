import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Request, Response } from 'express';
import { normalizePhone } from '@instafix/contracts/src/phone';
import { registrationSchema, loginSchema } from '@instafix/contracts';
import { AuthController } from '../auth/auth.controller';
import { createChallenge, consumeChallenge } from '../auth/email-challenges';
import { hashPassword, verifyPassword } from '../auth/security';
import { db } from '../database/client';

test('registration requires a valid email but login remains phone based', () => {
  const base = {
    firstName: 'Cliente',
    lastName: 'Prueba',
    phone: '+593984703819',
    password: 'una-clave-muy-segura',
  };
  assert.equal(registrationSchema.safeParse(base).success, false);
  assert.equal(registrationSchema.safeParse({ ...base, email: 'invalid' }).success, false);
  assert.equal(
    registrationSchema.parse({ ...base, email: ' Test@Example.com ' }).email,
    'test@example.com',
  );
  assert.equal(loginSchema.safeParse({ phone: base.phone, password: base.password }).success, true);
});

test(
  'email verification, single use, expiry, attempts, resend and password reset',
  { skip: process.env.INSTAFIX_INTEGRATION !== '1' },
  async () => {
    const email = `auth-test-${randomUUID()}@example.com`;
    const phone = `test-${randomUUID()}`;
    const req = { headers: { origin: 'http://localhost:5173' } } as Request;
    const res = { cookie: () => {} } as unknown as Response;
    const controller = new AuthController();
    let code = '';
    const mailer = async (_email: string, value: string) => {
      code = value;
    };
    const oldPassword = 'old-password-test-123';
    try {
      await assert.rejects(
        createChallenge({ email, purpose: 'REGISTER' }, true, async () => {
          throw new Error('SMTP de prueba no disponible');
        }),
      );
      assert.equal(await db.emailChallenge.count({ where: { email } }), 0);
      const challenge = await createChallenge(
        {
          email,
          phone,
          name: 'Prueba aislada',
          passwordHash: await hashPassword(oldPassword),
          purpose: 'REGISTER',
        },
        true,
        mailer,
      );
      assert.equal(await db.user.findUnique({ where: { phone } }), null);
      const stored = await db.emailChallenge.findUniqueOrThrow({
        where: { id: challenge.challengeId },
      });
      assert.notEqual(stored.codeHash, code);
      await assert.rejects(createChallenge({ email, purpose: 'REGISTER' }, true, mailer));
      const user = await controller.verifyEmail(
        { challengeId: challenge.challengeId, code },
        req,
        res,
      );
      assert.ok((await db.user.findUniqueOrThrow({ where: { id: user.id } })).emailVerifiedAt);
      await assert.rejects(
        controller.verifyEmail({ challengeId: challenge.challengeId, code }, req, res),
      );
      await db.emailChallenge.updateMany({
        where: { email },
        data: { createdAt: new Date(Date.now() - 120000) },
      });
      const reset = await createChallenge(
        { email, userId: user.id, purpose: 'RESET' },
        true,
        mailer,
      );
      await assert.rejects(consumeChallenge(reset.challengeId, code, 'REGISTER', async () => true));
      await controller.reset(
        { challengeId: reset.challengeId, code, password: 'new-password-test-123' },
        req,
      );
      const updated = await db.user.findUniqueOrThrow({ where: { id: user.id } });
      assert.equal(await verifyPassword('new-password-test-123', updated.passwordHash), true);
      assert.equal(await verifyPassword(oldPassword, updated.passwordHash), false);
      assert.equal(await db.session.count({ where: { userId: user.id } }), 0);
      await assert.rejects(
        controller.reset(
          { challengeId: reset.challengeId, code, password: 'another-password-123' },
          req,
        ),
      );
      await db.emailChallenge.updateMany({
        where: { email },
        data: { createdAt: new Date(Date.now() - 120000) },
      });
      const locked = await createChallenge(
        { email, purpose: 'RESET', userId: user.id },
        true,
        mailer,
      );
      for (let i = 0; i < 5; i++)
        await assert.rejects(
          consumeChallenge(locked.challengeId, '000000', 'RESET', async () => true),
        );
      await assert.rejects(consumeChallenge(locked.challengeId, code, 'RESET', async () => true));
      await db.emailChallenge.updateMany({
        where: { email },
        data: { createdAt: new Date(Date.now() - 120000) },
      });
      const expired = await createChallenge(
        { email, purpose: 'RESET', userId: user.id },
        true,
        mailer,
      );
      await db.emailChallenge.update({
        where: { id: expired.challengeId },
        data: { expiresAt: new Date(0) },
      });
      await assert.rejects(consumeChallenge(expired.challengeId, code, 'RESET', async () => true));
      await db.emailChallenge.updateMany({
        where: { email },
        data: { createdAt: new Date(Date.now() - 120000) },
      });
      const fresh = await createChallenge(
        { email, purpose: 'RESET', userId: user.id },
        true,
        mailer,
      );
      assert.ok(
        (await db.emailChallenge.findUniqueOrThrow({ where: { id: expired.challengeId } }))
          .consumedAt,
      );
      const outcomes = await Promise.allSettled([
        consumeChallenge(fresh.challengeId, code, 'RESET', async () => true),
        consumeChallenge(fresh.challengeId, code, 'RESET', async () => true),
      ]);
      assert.equal(outcomes.filter((r) => r.status === 'fulfilled').length, 1);
      await db.emailChallenge.updateMany({
        where: { email },
        data: { createdAt: new Date(Date.now() - 120000) },
      });
      await assert.rejects(
        createChallenge({ email, purpose: 'RESET', userId: user.id }, true, mailer),
      );
    } finally {
      await db.emailChallenge.deleteMany({ where: { email } });
      await db.user.deleteMany({ where: { phone } });
      await db.$disconnect();
    }
  },
);

test(
  'duplicate phones return the specific message and PostgreSQL prevents verification races',
  { skip: process.env.INSTAFIX_INTEGRATION !== '1' },
  async () => {
    const marker = randomUUID();
    const emails = [`duplicate-${marker}@example.com`, `pending-${marker}@example.com`];
    const phone = '+593990003333';
    const req = { headers: { origin: 'http://localhost:5173' } } as Request;
    const controller = new AuthController();
    let userId: string | undefined;
    let code = '';
    const duplicateMessage = { message: 'Ya existe una cuenta asociada a este número.' };
    try {
      const pending = await createChallenge(
        { email: emails[1], phone, name: 'Prueba', passwordHash: 'unused', purpose: 'REGISTER' },
        true,
        async (_email, value) => {
          code = value;
        },
      );
      const user = await db.user.create({
        data: { name: 'Prueba', phone, email: emails[0], passwordHash: 'unused' },
      });
      userId = user.id;
      for (const number of [phone, '0990003333', '990003333']) {
        await assert.rejects(
          controller.register(
            {
              firstName: 'Prueba',
              lastName: 'Registro',
              phone: normalizePhone(number, 'EC'),
              email: emails[1],
              password: 'password-test-123',
            },
            req,
          ),
          duplicateMessage,
        );
      }
      // Bypassing the controller still cannot create a second row with this phone.
      await assert.rejects(
        db.user.create({
          data: { name: 'Duplicado', phone, email: emails[1], passwordHash: 'unused' },
        }),
        { code: 'P2002' },
      );
      await assert.rejects(
        controller.verifyEmail({ challengeId: pending.challengeId, code }, req, {
          cookie: () => {},
        } as unknown as Response),
        duplicateMessage,
      );
      assert.equal(await db.user.count({ where: { phone } }), 1);
    } finally {
      await db.emailChallenge.deleteMany({ where: { email: { in: emails } } });
      if (userId) await db.user.delete({ where: { id: userId } });
      await db.$disconnect();
    }
  },
);
