import { appointmentSchema } from '@instafix/contracts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { homeSection, pages, resolvePage } from '../../../web/src/app/navigation';
test('direct links and navigation use one canonical page', () => {
  for (const page of pages) assert.equal(resolvePage('#' + page), page);
  assert.equal(resolvePage(''), 'inicio');
  assert.equal(resolvePage('#'), 'inicio');
  assert.equal(resolvePage('#unknown'), 'inicio');
  // Quiénes somos y Cómo funciona ahora son secciones de Inicio: los enlaces antiguos siguen sirviendo.
  for (const link of ['#quienes-somos', '#como', '#nuestro-trabajo']) {
    assert.equal(resolvePage(link), 'inicio');
    assert.equal(homeSection(link), link.slice(1));
  }
  assert.equal(homeSection('#servicios'), null);
  assert.equal(resolvePage('#restablecer?token=abc'), 'cuenta');
});
const appointment = {
  userId: '00000000-0000-4000-8000-000000000001',
  title: 'Mantenimiento',
  device: 'PS5',
  startsAt: '2026-10-05T10:00:00-05:00',
  endsAt: '2026-10-05T11:00:00-05:00',
  timeZone: 'America/Guayaquil',
  address: '',
  technician: '',
  status: 'PENDING_LOCATION',
};
test('appointments require a real time zone and ordered explicit dates', () => {
  assert.equal(appointmentSchema.safeParse(appointment).success, true);
  assert.equal(
    appointmentSchema.safeParse({ ...appointment, endsAt: appointment.startsAt }).success,
    false,
  );
  assert.equal(appointmentSchema.safeParse({ ...appointment, timeZone: 'fake' }).success, false);
  assert.equal(
    appointmentSchema.safeParse({ ...appointment, startsAt: '2026-10-05T10:00' }).success,
    false,
  );
});
