import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanNumberText, numberFromText } from './NumberField';
import { dropIndex, moveItem } from './SortableList';
import { locationLinks } from '../appointments/AppointmentLocation';

test('números sin el 0 delante; coma o punto decimal', () => {
  assert.equal(cleanNumberText('05'), '5');
  assert.equal(cleanNumberText('0060'), '60');
  assert.equal(cleanNumberText('0'), '0');
  assert.equal(cleanNumberText('', 2), '');
  assert.equal(cleanNumberText('025,5', 2), '25.5');
  assert.equal(cleanNumberText('0.50', 2), '0.50');
  assert.equal(cleanNumberText('.5', 2), '0.5');
  assert.equal(cleanNumberText('12.345', 2), '12.34');
  assert.equal(cleanNumberText('1.2.3', 2), '1.23');
  assert.equal(cleanNumberText('a1b2', 0), '12');
  assert.equal(cleanNumberText('-5'), '5');
  assert.equal(numberFromText(''), 0);
  assert.equal(numberFromText('25.5'), 25.5);
});

test('arrastrar: posición final y lista nueva', () => {
  // Tres filas de 50 px: centros 25, 75, 125.
  const mids = [25, 75, 125];
  assert.equal(dropIndex(mids, 0, 25), 0, 'sin moverse');
  assert.equal(dropIndex(mids, 0, 80), 1, 'pasa la segunda');
  assert.equal(dropIndex(mids, 0, 200), 2, 'al final');
  assert.equal(dropIndex(mids, 2, 10), 0, 'al principio');
  assert.deepEqual(moveItem(['a', 'b', 'c'], 0, 2), ['b', 'c', 'a']);
  assert.deepEqual(moveItem(['a', 'b', 'c'], 2, 0), ['c', 'a', 'b']);
  assert.deepEqual(moveItem(['a', 'b', 'c'], 1, 1), ['a', 'b', 'c']);
});

test('ubicación: coordenadas, enlace del cliente o dirección escrita → Google Maps', () => {
  const gps = locationLinks({ locationLatitude: -0.2, locationLongitude: -78.43 })!;
  assert.match(gps.view, /query=-0\.2%2C-78\.43/);
  assert.match(gps.directions, /destination=-0\.2%2C-78\.43/);
  const written = locationLinks({ address: 'Av. Interoceánica y Pampite, Cumbayá' })!;
  assert.match(written.view, /^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=/);
  assert.match(decodeURIComponent(written.view), /Interoceánica y Pampite, Cumbayá, Ecuador/);
  assert.equal(locationLinks({ address: '' }), null);
  assert.equal(locationLinks({}), null);
  const area = locationLinks({ locationArea: 'Cumbayá' })!;
  assert.match(decodeURIComponent(area.view), /Cumbayá, Ecuador/);
});
