import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  adminGroups,
  adminItems,
  DEFAULT_ADMIN_TAB,
  findAdminItem,
  isAdminTab,
  mobilePrimary,
} from './admin-nav';

test('menú de administración: 4 secciones + cuenta, cada ventana una sola vez', () => {
  assert.deepEqual(
    adminGroups.map((g) => g.label),
    ['Operación', 'Catálogo y web', 'Clientes y equipo', 'Sistema', 'Cuenta'],
  );
  const ids = adminItems.map((item) => item.id);
  assert.equal(ids.length, 15);
  assert.ok(ids.includes('cuenta'));
  assert.equal(new Set(ids).size, ids.length, 'sin ventanas repetidas');
  for (const item of adminItems) {
    assert.ok(item.label && item.description, `${item.id} tiene título y descripción`);
    assert.equal(findAdminItem(item.id).group.length > 0, true);
  }
});

test('barra inferior del móvil: 4 accesos válidos + «Más»', () => {
  assert.equal(mobilePrimary.length, 4);
  for (const id of mobilePrimary) assert.ok(isAdminTab(id), id);
  assert.ok(isAdminTab(DEFAULT_ADMIN_TAB));
  // Los nombres cortos caben en la barra (≈ 10 caracteres).
  for (const id of mobilePrimary) {
    const item = findAdminItem(id);
    assert.ok((item.short ?? item.label).length <= 10, item.label);
  }
});

test('la ventana guardada solo se acepta si existe', () => {
  for (const bad of [null, '', 'Servicios', 'admin', '__proto__', 42])
    assert.equal(isAdminTab(bad), false);
  assert.equal(isAdminTab('servicios'), true);
});
