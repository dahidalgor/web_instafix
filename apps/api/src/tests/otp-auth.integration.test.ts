import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Request, Response } from 'express';
import { AuthController } from '../auth/auth.controller';
import { SecurityController } from '../account/security.controller';
import { hashPassword, newToken, tokenHash, verifyPassword } from '../auth/security';
import { OTP_LIMITS, VerificationService } from '../auth/verification.service';
import { db } from '../database/client';
import { setEmailProvider } from '../mail/email.service';
import { ProviderError } from '../integrations/provider-error';
import type { WhatsAppOtpProvider } from '../whatsapp/otp.provider';

const enabled = process.env.INSTAFIX_INTEGRATION === '1';
const origin = 'http://localhost:5173';
/** Teléfonos de prueba únicos y válidos de Ecuador: +593 99 XXX XXXX. */
const testPhone = () => `+59399${String(randomInt(1000000, 9999999))}`;

class FakeWhatsApp implements WhatsAppOtpProvider {
  readonly name = 'TEST';
  sent: { to: string; code: string }[] = [];
  fail = false;
  async sendAuthenticationCode(to: string, code: string) {
    if (this.fail) throw new ProviderError('Bird simulado caído', 'RETRY');
    this.sent.push({ to, code });
    return { messageId: `wamid.test.${randomUUID()}` };
  }
  last(to: string) {
    return [...this.sent].reverse().find((m) => m.to === to)!.code;
  }
}
const emails: { to: string; html: string; subject: string }[] = [];
setEmailProvider({
  name: 'TEST',
  async send(to, message) {
    emails.push({ to, html: message.html, subject: message.subject });
    return { messageId: `<test-${randomUUID()}@brevo>` };
  },
});
process.env.SMTP_HOST ||= 'smtp-relay.brevo.com';
process.env.SMTP_FROM ||= 'Instafix <test@instafix.ec>';
process.env.SMTP_USER ||= 'test';
process.env.SMTP_PASSWORD ||= 'test';

function request(cookie = '') {
  return { headers: { origin, cookie } } as unknown as Request;
}
function response() {
  const jar: { cookie?: string } = {};
  const res = {
    cookie: (name: string, value: string) => {
      jar.cookie = `${name}=${value}`;
    },
    clearCookie: () => {},
  } as unknown as Response;
  return { res, jar };
}
const tokenFrom = (html: string) => html.match(/token=([a-f0-9]{64})/)![1];
/** Simula el paso del tiempo para el cooldown de reenvío sin esperar. */
async function ageChallenges(phone: string, seconds = 61) {
  await db.phoneChallenge.updateMany({
    where: { phone },
    data: { createdAt: new Date(Date.now() - seconds * 1000) },
  });
}
async function cleanup(phones: string[], emailList: string[]) {
  const users = await db.user.findMany({
    where: { OR: [{ phone: { in: phones } }, { email: { in: emailList } }] },
  });
  await db.appointment.deleteMany({
    where: { OR: [{ contactPhone: { in: phones } }, { userId: { in: users.map((u) => u.id) } }] },
  });
  await db.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
  await db.phoneChallenge.deleteMany({ where: { phone: { in: phones } } });
}

test(
  'WhatsApp registration: OTP required, single use, wrong/expired, resend, limits, duplicates and provider failure',
  { skip: !enabled },
  async () => {
    const wa = new FakeWhatsApp();
    const auth = new AuthController(new VerificationService(wa));
    const phone = testPhone();
    const other = testPhone();
    const email = `otp-${randomUUID()}@example.com`;
    const email2 = `otp-${randomUUID()}@example.com`;
    try {
      // Formatos equivalentes resuelven al mismo E.164 en el backend.
      const local = '0' + phone.slice(4);
      const ticket = await auth.register(
        {
          firstName: 'ana',
          lastName: 'prueba',
          email,
          phone: local,
          password: 'clave-muy-segura-1',
        },
        request(),
      );
      assert.equal(wa.sent.at(-1)!.to, phone);
      assert.match(ticket.maskedPhone, /^\+593 99 \*\*\* \*\*\d\d$/);
      // Cuenta pendiente: todavía no existe un usuario ni puede iniciar sesión.
      assert.equal(await db.user.findUnique({ where: { phone } }), null);
      const stored = await db.phoneChallenge.findUniqueOrThrow({
        where: { id: ticket.verificationId },
      });
      assert.notEqual(stored.codeHash, wa.last(phone));
      assert.equal(stored.purpose, 'PHONE_VERIFICATION');

      // Cooldown: no se puede reenviar antes de 60 s.
      await assert.rejects(
        auth.resend({ verificationId: ticket.verificationId }, request()),
        /Espera/,
      );
      // Código incorrecto.
      await assert.rejects(
        auth.verifyPhone(
          {
            verificationId: ticket.verificationId,
            code: '000000' === wa.last(phone) ? '111111' : '000000',
          },
          request(),
          response().res,
        ),
        /incorrecto/,
      );
      // Reenvío invalida el código anterior.
      const firstCode = wa.last(phone);
      await ageChallenges(phone);
      const resent = await auth.resend({ verificationId: ticket.verificationId }, request());
      await assert.rejects(
        auth.verifyPhone(
          { verificationId: ticket.verificationId, code: firstCode },
          request(),
          response().res,
        ),
      );
      // Código de verificación no sirve para restablecer contraseña (propósitos separados).
      await assert.rejects(
        auth.verifyResetCode(
          { verificationId: resent.verificationId, code: wa.last(phone) },
          request(),
        ),
      );
      const { res, jar } = response();
      const user = await auth.verifyPhone(
        { verificationId: resent.verificationId, code: wa.last(phone) },
        request(),
        res,
      );
      assert.ok(user.phoneVerifiedAt);
      assert.equal(user.emailVerifiedAt, null); // El correo es opcional y queda sin verificar.
      assert.equal(user.name, 'Ana Prueba');
      assert.ok(jar.cookie);
      // Uso único.
      await assert.rejects(
        auth.verifyPhone(
          { verificationId: resent.verificationId, code: wa.last(phone) },
          request(),
          response().res,
        ),
      );
      // Un WhatsApp = una cuenta.
      await assert.rejects(
        auth.register(
          {
            firstName: 'Otra',
            lastName: 'Persona',
            email: email2,
            phone,
            password: 'clave-muy-segura-2',
          },
          request(),
        ),
        (e: any) => e.getResponse().code === 'PHONE_IN_USE',
      );

      // Expirado.
      const t2 = await auth.register(
        {
          firstName: 'Beto',
          lastName: 'Prueba',
          email: email2,
          phone: other,
          password: 'clave-muy-segura-3',
        },
        request(),
      );
      await db.phoneChallenge.update({
        where: { id: t2.verificationId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await assert.rejects(
        auth.verifyPhone(
          { verificationId: t2.verificationId, code: wa.last(other) },
          request(),
          response().res,
        ),
      );

      // Límite de intentos: 5 fallos bloquean incluso el código correcto.
      await ageChallenges(other);
      const t3 = await auth.resend({ verificationId: t2.verificationId }, request());
      for (let i = 0; i < 5; i++)
        await assert.rejects(
          auth.verifyPhone(
            {
              verificationId: t3.verificationId,
              code: wa.last(other) === '123456' ? '654321' : '123456',
            },
            request(),
            response().res,
          ),
        );
      await assert.rejects(
        auth.verifyPhone(
          { verificationId: t3.verificationId, code: wa.last(other) },
          request(),
          response().res,
        ),
      );

      // Máximo de reenvíos por solicitud (y 5 códigos por hora por número).
      await db.phoneChallenge.updateMany({
        where: { phone: other },
        data: { createdAt: new Date(Date.now() - 120000) },
      });
      for (
        let i = await db.phoneChallenge.count({ where: { phone: other } });
        i <= OTP_LIMITS.maxResends;
        i++
      ) {
        await auth.resend(
          {
            verificationId: (
              await db.phoneChallenge.findFirstOrThrow({
                where: { phone: other, consumedAt: null },
                orderBy: { createdAt: 'desc' },
              })
            ).id,
          },
          request(),
        );
        await ageChallenges(other, 70);
      }
      await assert.rejects(
        auth.resend(
          {
            verificationId: (
              await db.phoneChallenge.findFirstOrThrow({
                where: { phone: other, consumedAt: null },
                orderBy: { createdAt: 'desc' },
              })
            ).id,
          },
          request(),
        ),
        (e: any) => e.getStatus() === 429,
      );

      // Fallo del proveedor de WhatsApp: no queda desafío ni cuenta verificada, y se informa el error.
      const failing = testPhone();
      wa.fail = true;
      await assert.rejects(
        auth.register(
          {
            firstName: 'Caro',
            lastName: 'Prueba',
            email: `otp-${randomUUID()}@example.com`,
            phone: failing,
            password: 'clave-muy-segura-4',
          },
          request(),
        ),
        (e: any) => e.getStatus() === 503,
      );
      wa.fail = false;
      assert.equal(await db.phoneChallenge.count({ where: { phone: failing } }), 0);
      assert.equal(await db.user.count({ where: { phone: failing } }), 0);
      const log = await db.communicationLog.findFirstOrThrow({
        where: { kind: 'OTP_PHONE_VERIFICATION', status: 'FAILED' },
        orderBy: { createdAt: 'desc' },
      });
      assert.equal(log.recipient.includes(failing.slice(4, 10)), false); // destinatario enmascarado
    } finally {
      await cleanup([phone, other], [email, email2]);
    }
  },
);

test(
  'race: two pending registrations of the same phone create only one account',
  { skip: !enabled },
  async () => {
    const wa = new FakeWhatsApp();
    const auth = new AuthController(new VerificationService(wa));
    const phone = testPhone();
    const e1 = `race-${randomUUID()}@example.com`;
    const e2 = `race-${randomUUID()}@example.com`;
    try {
      const a = await auth.register(
        { firstName: 'Uno', lastName: 'Prueba', email: e1, phone, password: 'clave-muy-segura-1' },
        request(),
      );
      const codeA = wa.last(phone);
      await ageChallenges(phone);
      // El segundo registro invalida el primero (mismo número y propósito).
      const b = await auth.register(
        { firstName: 'Dos', lastName: 'Prueba', email: e2, phone, password: 'clave-muy-segura-2' },
        request(),
      );
      await assert.rejects(
        auth.verifyPhone(
          { verificationId: a.verificationId, code: codeA },
          request(),
          response().res,
        ),
      );
      await auth.verifyPhone(
        { verificationId: b.verificationId, code: wa.last(phone) },
        request(),
        response().res,
      );
      assert.equal(await db.user.count({ where: { phone } }), 1);
    } finally {
      await cleanup([phone], [e1, e2]);
    }
  },
);

test(
  'unverified login, WhatsApp recovery, email recovery, optional email verification and phone change',
  { skip: !enabled },
  async () => {
    const wa = new FakeWhatsApp();
    const verification = new VerificationService(wa);
    const auth = new AuthController(verification);
    const security = new SecurityController(verification);
    const phone = testPhone();
    const newPhone = testPhone();
    const unverifiedPhone = testPhone();
    const email = `rec-${randomUUID()}@example.com`;
    const changedEmail = `rec-${randomUUID()}@example.com`;
    const legacyEmail = `rec-${randomUUID()}@example.com`;
    try {
      // Cuenta antigua sin teléfono verificado: login correcto exige OTP y no crea sesión.
      const legacy = await db.user.create({
        data: {
          name: 'Legado',
          phone: unverifiedPhone,
          email: legacyEmail,
          emailVerifiedAt: new Date(),
          passwordHash: await hashPassword('clave-antigua-123'),
        },
      });
      const { res: r0, jar: j0 } = response();
      const denied = await auth
        .login({ phone: unverifiedPhone, password: 'clave-antigua-123' }, request(), r0)
        .catch((e) => e);
      assert.equal(denied.getResponse().code, 'PHONE_UNVERIFIED');
      assert.equal(j0.cookie, undefined);
      assert.equal(await db.user.count({ where: { phone: unverifiedPhone } }), 1);
      // Recuperar por WhatsApp no envía a un teléfono no verificado (respuesta genérica).
      const before = wa.sent.length;
      await ageChallenges(unverifiedPhone);
      const decoy = await auth.resetByWhatsApp({ phone: unverifiedPhone }, request());
      assert.match(decoy.message, /Si existe una cuenta verificada/);
      assert.equal(wa.sent.length, before);
      await assert.rejects(
        auth.verifyResetCode({ verificationId: decoy.verificationId, code: '123456' }, request()),
      );
      // Una sesión antigua de cliente no verificado deja de ser válida.
      const legacyToken = newToken();
      await db.session.create({
        data: {
          userId: legacy.id,
          tokenHash: tokenHash(legacyToken),
          expiresAt: new Date(Date.now() + 60000),
        },
      });
      await assert.rejects(
        security.changePassword(
          { currentPassword: 'x', password: 'y'.repeat(12) },
          request(`instafix_session=${legacyToken}`),
        ),
        (e: any) => e.getResponse().code === 'PHONE_UNVERIFIED',
      );

      // Cuenta verificada.
      const ticket = await auth.register(
        { firstName: 'Rec', lastName: 'Prueba', email, phone, password: 'clave-original-123' },
        request(),
      );
      const { res, jar } = response();
      const user = await auth.verifyPhone(
        { verificationId: ticket.verificationId, code: wa.last(phone) },
        request(),
        res,
      );
      const cookie = jar.cookie!;

      // Recuperación por WhatsApp.
      await ageChallenges(phone);
      const reset = await auth.resetByWhatsApp({ phone }, request());
      const { resetToken } = await auth.verifyResetCode(
        { verificationId: reset.verificationId, code: wa.last(phone) },
        request(),
      );
      await auth.completeReset({ token: resetToken, password: 'clave-por-whatsapp-1' }, request());
      assert.equal(
        await verifyPassword(
          'clave-por-whatsapp-1',
          (await db.user.findUniqueOrThrow({ where: { id: user.id } })).passwordHash,
        ),
        true,
      );
      assert.equal(await db.session.count({ where: { userId: user.id } }), 0); // sesiones cerradas
      await assert.rejects(
        auth.completeReset({ token: resetToken, password: 'otra-clave-123456' }, request()),
        /caducó o ya se utilizó/,
      );
      // El token de recuperación no es una sesión.
      await assert.rejects(
        security.sendEmailVerification(request(`instafix_session=${resetToken}`)),
      );

      // Correo sin verificar: la recuperación por correo no envía nada.
      const sentBefore = emails.length;
      await auth.resetByEmail({ email }, request());
      assert.equal(emails.length, sentBefore);

      // Verificación opcional del correo desde Mi cuenta.
      const { res: r2, jar: j2 } = response();
      await auth.login({ phone, password: 'clave-por-whatsapp-1' }, request(), r2);
      const session = request(j2.cookie!);
      const sent = await security.sendEmailVerification(session);
      assert.equal(sent.accepted, true);
      const verifyToken = tokenFrom(emails.at(-1)!.html);
      assert.equal(emails.at(-1)!.to, email);
      await auth.verifyEmail({ token: verifyToken }, request());
      assert.ok((await db.user.findUniqueOrThrow({ where: { id: user.id } })).emailVerifiedAt);
      await assert.rejects(auth.verifyEmail({ token: verifyToken }, request())); // reutilización

      // Recuperación por correo verificado.
      await auth.resetByEmail({ email }, request());
      const mailToken = tokenFrom(emails.at(-1)!.html);
      assert.ok(emails.at(-1)!.html.includes('#restablecer?token='));
      await auth.completeReset({ token: mailToken, password: 'clave-por-correo-12' }, request());
      assert.equal(
        await verifyPassword(
          'clave-por-correo-12',
          (await db.user.findUniqueOrThrow({ where: { id: user.id } })).passwordHash,
        ),
        true,
      );

      // Caducidad del enlace de verificación.
      const { res: r3, jar: j3 } = response();
      await auth.login({ phone, password: 'clave-por-correo-12' }, request(), r3);
      const s3 = request(j3.cookie!);
      // Cambiar el correo lo deja sin verificar e invalida enlaces anteriores.
      const changed = await security.changeEmail(
        { email: changedEmail, password: 'clave-por-correo-12' },
        s3,
      );
      assert.equal(changed.emailVerifiedAt, null);
      await db.authToken.deleteMany({ where: { userId: user.id, purpose: 'EMAIL_VERIFICATION' } });
      await security.sendEmailVerification(s3);
      const expiring = tokenFrom(emails.at(-1)!.html);
      await db.authToken.update({
        where: { tokenHash: tokenHash(expiring) },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await assert.rejects(auth.verifyEmail({ token: expiring }, request()));

      // Cambio de WhatsApp: el número no cambia hasta verificar el nuevo.
      await assert.rejects(
        security.startPhoneChange({ phone: unverifiedPhone, password: 'clave-por-correo-12' }, s3),
        /Ya existe una cuenta/,
      );
      const change = await security.startPhoneChange(
        { phone: newPhone, password: 'clave-por-correo-12' },
        s3,
      );
      assert.equal((await db.user.findUniqueOrThrow({ where: { id: user.id } })).phone, phone);
      const changedUser = await security.verifyPhoneChange(
        { verificationId: change.verificationId, code: wa.last(newPhone) },
        s3,
      );
      assert.equal(changedUser.phone, newPhone);
      assert.ok(changedUser.phoneVerifiedAt);
      void cookie;
    } finally {
      await cleanup([phone, newPhone, unverifiedPhone], [email, changedEmail, legacyEmail]);
    }
  },
);

test(
  'guest appointments are linked only after the same phone is verified by OTP',
  { skip: !enabled },
  async () => {
    const wa = new FakeWhatsApp();
    const auth = new AuthController(new VerificationService(wa));
    const phone = testPhone();
    const email = `guest-${randomUUID()}@example.com`;
    try {
      const guest = await db.appointment.create({
        data: {
          contactName: 'Invitado',
          contactPhone: phone,
          title: 'Mi laptop no enciende',
          device: 'Por especificar',
          startsAt: new Date(Date.now() + 86400000),
          endsAt: new Date(Date.now() + 90000000),
          address: '',
          technician: '',
        },
      });
      const ticket = await auth.register(
        { firstName: 'Invitado', lastName: 'Prueba', email, phone, password: 'clave-muy-segura-9' },
        request(),
      );
      // Antes del OTP: sin vincular.
      assert.equal(
        (await db.appointment.findUniqueOrThrow({ where: { id: guest.id } })).userId,
        null,
      );
      const user = await auth.verifyPhone(
        { verificationId: ticket.verificationId, code: wa.last(phone) },
        request(),
        response().res,
      );
      assert.equal(user.claimedAppointments, 1);
      assert.equal(
        (await db.appointment.findUniqueOrThrow({ where: { id: guest.id } })).userId,
        user.id,
      );
    } finally {
      await cleanup([phone], [email]);
    }
  },
);
