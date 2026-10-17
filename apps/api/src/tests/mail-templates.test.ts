import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  appointmentCancelledEmail,
  appointmentConfirmedEmail,
  appointmentCreatedEmail,
  appointmentRescheduledEmail,
  emailVerificationEmail,
  passwordResetEmail,
} from '../mail/templates';

const base = {
  name: 'David <b>Pérez</b>',
  startsAt: '2026-10-24T20:30:00.000Z',
  timeZone: 'America/Guayaquil',
  request: 'Mi PS5 se apaga después de jugar unos minutos & más',
  guest: false,
};

test('booking email: request received, pending, Ecuador time, escaped; never says confirmed', () => {
  const email = appointmentCreatedEmail(base);
  assert.equal(email.subject, 'Recibimos tu solicitud de visita · Instafix');
  assert.ok(email.html.includes('✓ Solicitud recibida'));
  assert.equal(
    /confirmada/i.test(email.subject + email.text.replace(/pendiente de confirmación/gi, '')),
    false,
  );
  assert.ok(email.text.includes('Estado: Pendiente de confirmación'));
  assert.ok(email.text.includes('Sábado, 24 de octubre'));
  assert.ok(email.text.includes('15:30'));
  assert.ok(email.html.includes('Solicitud'));
  // Nunca afirma un servicio realizado: solo la necesidad descrita por el cliente.
  assert.equal(/Servicio realizado/i.test(email.html), false);
  assert.ok(email.html.includes('&amp; más'));
  assert.ok(
    email.html.includes('David &lt;b&gt;Pérez&lt;/b&gt;') || !email.html.includes('<b>Pérez'),
  );
  assert.ok(email.html.includes('Ver mi cita'));
  assert.ok(email.html.includes('max-width:600px'));
  assert.ok(email.text.includes('WhatsApp'));
});

test('confirmation email: technician, date, time and request', () => {
  const email = appointmentConfirmedEmail({ ...base, technicianName: 'Anthony' });
  assert.equal(email.subject, 'Tu visita está confirmada ✓ · Instafix');
  assert.ok(email.html.includes('✓ Tu visita está confirmada'));
  assert.ok(email.text.includes('Técnico asignado: Anthony'));
  assert.ok(email.text.includes('Hora estimada: 15:30'));
  assert.ok(email.text.includes('Solicitud: “Mi PS5 se apaga'));
});

test('guest booking email offers account creation instead of a login-only button', () => {
  const email = appointmentCreatedEmail({ ...base, guest: true });
  assert.ok(email.text.includes('Tu solicitud de visita fue creada correctamente'));
  assert.ok(email.text.includes('Crea tu cuenta'));
  assert.equal(email.html.includes('Ver mi cita'), false);
});

test('reschedule shows previous and new date; cancellation has its own template', () => {
  const rescheduled = appointmentRescheduledEmail({
    ...base,
    previousStartsAt: '2026-10-23T15:00:00.000Z',
  });
  assert.ok(rescheduled.text.includes('Fecha anterior: Viernes, 23 de octubre · 10:00'));
  assert.ok(rescheduled.text.includes('Nueva fecha: Sábado, 24 de octubre'));
  const cancelled = appointmentCancelledEmail(base);
  assert.equal(cancelled.subject, 'Tu cita con Instafix fue cancelada');
});

test('verification and reset emails carry single-use links, not codes', () => {
  const token = 'a'.repeat(64);
  const verify = emailVerificationEmail({
    name: 'Ana',
    url: `https://instafix.ec/#verificar-correo?token=${token}`,
  });
  assert.ok(verify.html.includes(token));
  assert.ok(verify.text.includes('24 horas'));
  const reset = passwordResetEmail({
    name: 'Ana',
    url: `https://instafix.ec/#restablecer?token=${token}`,
  });
  assert.ok(reset.text.includes('30 minutos'));
});
