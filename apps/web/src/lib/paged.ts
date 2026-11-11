import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';

export type Page<T> = { items: T[]; total: number; page: number; pageSize: number };

/**
 * Lista larga por páginas: carga la primera y «Cargar más» añade la siguiente. Cambiar `path`
 * (p. ej. otros filtros) vuelve a empezar; una respuesta vieja nunca pisa a una nueva.
 * `path` null = aún no se pide nada.
 */
export function usePaged<T>(path: string | null) {
  const [items, setItems] = useState<T[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const request = useRef(0);

  const fetchPage = useCallback(
    async (next: number, replace: boolean) => {
      if (!path) return;
      const id = ++request.current;
      setLoading(true);
      setError('');
      try {
        const sep = path.includes('?') ? '&' : '?';
        const res = await api<Page<T>>(`${path}${sep}page=${next}`);
        if (id !== request.current) return;
        setItems((current) => (replace || !current ? res.items : [...current, ...res.items]));
        setTotal(res.total);
        setPage(next);
      } catch (e) {
        if (id === request.current)
          setError(e instanceof Error ? e.message : 'No se pudo cargar la lista.');
      } finally {
        if (id === request.current) setLoading(false);
      }
    },
    [path],
  );

  useEffect(() => {
    setItems(null);
    void fetchPage(1, true);
  }, [fetchPage]);

  return {
    items,
    total,
    loading,
    error,
    hasMore: items !== null && items.length < total,
    loadMore: () => fetchPage(page + 1, false),
    /** Vuelve a cargar desde la primera página (tras guardar un cambio). */
    reload: () => fetchPage(1, true),
    setItems,
  };
}
