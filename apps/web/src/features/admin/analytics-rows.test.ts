import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyticsRows } from './AdminAnalytics';

test('estadísticas: nombres de la web, ceros visibles, orden por visitas y secciones aparte', () => {
  const rows = analyticsRows({
    days: 30,
    visits: 10,
    sessions: 4,
    pages: [
      { page: 'inicio', visits: 5, averageSeconds: 40 },
      { page: 'agenda', visits: 3, averageSeconds: 90 },
      { page: 'como', visits: 1, averageSeconds: 12 },
      { page: 'antigua', visits: 1, averageSeconds: 3 },
    ],
  });
  assert.deepEqual(
    rows.pages.slice(0, 2).map((r) => [r.label, r.visits]),
    [
      ['Inicio', 5],
      ['Agendar cita', 3],
    ],
  );
  // Todas las páginas del menú aparecen, también sin visitas.
  assert.equal(rows.pages.length, 8);
  assert.ok(rows.pages.some((r) => r.label === 'Mi cuenta' && r.visits === 0));
  assert.deepEqual(
    rows.sections.map((r) => r.label),
    ['Cómo funciona', 'Nuestro trabajo', 'Quiénes somos'],
  );
  assert.deepEqual(
    rows.other.map((r) => r.page),
    ['antigua'],
  );
});
