/**
 * Página y tamaño de una lista larga desde la consulta (`?page=2&pageSize=20`). Valores raros
 * se corrigen al rango permitido: nunca se piden miles de filas de una vez.
 */
export function pageParams(page: unknown, size: unknown, fallback = 20, max = 100) {
  const n = (value: unknown, def: number) => {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(parsed) ? parsed : def;
  };
  return {
    page: Math.min(10000, Math.max(1, n(page, 1))),
    pageSize: Math.min(max, Math.max(5, n(size, fallback))),
  };
}
