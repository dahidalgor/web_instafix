import assert from 'node:assert/strict';
import { test } from 'node:test';
import { confirmationReminderMessage } from '@instafix/contracts';
import {
  activeTimeBetween,
  addActiveTime,
  confirmDeadline,
  holdDeadline,
  holdDeadlineForExisting,
  isQuietTime,
  responseDeadline,
} from '../booking/hold';

/** Hora de Ecuador (UTC-5). */
const ec = (value: string) => new Date(`${value}:00-05:00`);
const H = 3600000;

test('horario nocturno: de 22H00 a 07H00 el reloj se detiene', () => {
  assert.equal(isQuietTime(ec('2026-11-20T21:59')), false);
  assert.equal(isQuietTime(ec('2026-11-20T22:00')), true);
  assert.equal(isQuietTime(ec('2026-11-21T06:59')), true);
  assert.equal(isQuietTime(ec('2026-11-21T07:00')), false);
  // 4 h desde las 20H00: 2 h hoy y 2 h desde las 07H00 de mañana.
  assert.deepEqual(addActiveTime(ec('2026-11-20T20:00'), 4 * H), ec('2026-11-21T09:00'));
  // Agendada a las 23H00: el plazo empieza a las 07H00.
  assert.deepEqual(addActiveTime(ec('2026-11-20T23:00'), 2 * H), ec('2026-11-21T09:00'));
  assert.equal(activeTimeBetween(ec('2026-11-20T21:00'), ec('2026-11-21T08:00')), 2 * H);
  assert.deepEqual(responseDeadline(ec('2026-11-20T10:15')), ec('2026-11-20T12:15'));
});

test('reserva provisional: 4 h activas para confirmar y como tarde 3 h antes de la cita', () => {
  // Normal: 10H00 → 14H00.
  assert.deepEqual(
    holdDeadline(ec('2026-11-20T10:00'), ec('2026-11-25T10:00')),
    ec('2026-11-20T14:00'),
  );
  // Cita pronto: vence 3 h antes (11H00 para una cita a las 14H00).
  assert.deepEqual(
    holdDeadline(ec('2026-11-20T09:00'), ec('2026-11-20T14:00')),
    ec('2026-11-20T11:00'),
  );
  // 3 h antes cae de noche (cita a las 08H00): vence a las 22H00 de la víspera.
  assert.deepEqual(
    holdDeadline(ec('2026-11-20T20:00'), ec('2026-11-21T08:00')),
    ec('2026-11-20T22:00'),
  );
  // Sin 30 min para confirmar (21H50 para una cita a las 08H00 de mañana): no se acepta.
  assert.equal(holdDeadline(ec('2026-11-20T21:50'), ec('2026-11-21T08:00')), null);
  assert.equal(holdDeadline(ec('2026-11-20T23:00'), ec('2026-11-21T08:00')), null);
  // Citas que ya existen (Cal.com directo): nunca se rechazan, pero siempre antes de la cita.
  const existing = holdDeadlineForExisting(ec('2026-11-20T23:00'), ec('2026-11-21T08:00'));
  assert.ok(existing < ec('2026-11-21T08:00'));
  assert.ok(existing > ec('2026-11-20T23:00'));
});

test('plazo efectivo: el primero de los dos; la ubicación anula el del cliente', () => {
  const base = {
    status: 'PENDING_LOCATION' as const,
    assignedTechnicianId: null,
    deletedAt: null,
    holdExpiresAt: ec('2026-11-20T14:00'),
    responseDueAt: ec('2026-11-20T12:00'),
    locationReceivedAt: null,
  };
  assert.deepEqual(confirmDeadline(base), ec('2026-11-20T12:00'));
  assert.deepEqual(
    confirmDeadline({ ...base, locationReceivedAt: ec('2026-11-20T11:00') }),
    ec('2026-11-20T14:00'),
  );
  assert.equal(confirmDeadline({ ...base, assignedTechnicianId: 'tecnico' }), null);
  assert.equal(confirmDeadline({ ...base, status: 'CONFIRMED' as never }), null);
});

test('mensajes para confirmar: hora de la cita, plazo y última oportunidad', () => {
  const visit = {
    contactName: 'Saúl Parra',
    startsAt: ec('2026-11-26T10:00'),
    timeZone: 'America/Guayaquil',
  };
  const now = ec('2026-11-20T10:10');
  assert.deepEqual(confirmationReminderMessage(visit, ec('2026-11-20T14:00'), now, false), {
    title: 'Cita pendiente por confirmar',
    body: 'Saúl solicitó una cita para el jueves 26 de noviembre a las 10H00. Confírmala antes de las 14H00 o se cancelará.',
  });
  assert.deepEqual(confirmationReminderMessage(visit, ec('2026-11-20T14:00'), now, true), {
    title: 'Última oportunidad: cita de Saúl',
    body: 'Se cancela a las 14H00 si nadie la confirma. Es para el jueves 26 de noviembre a las 10H00.',
  });
  // Plazo otro día: se dice cuál.
  assert.match(
    confirmationReminderMessage(visit, ec('2026-11-21T09:00'), now, false).body,
    /antes del sábado 21 de noviembre a las 09H00/,
  );
});
