import { useEffect, useState } from 'react';
import { ListSkeleton } from '../../components/ui/Skeleton';
import { api } from '../../lib/api';

type Account = {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  role: 'CUSTOMER' | 'ADMIN' | 'TECHNICIAN';
  active: boolean;
  phoneVerifiedAt: string | null;
  emailVerifiedAt: string | null;
  createdAt: string;
  appointments: number;
  blocked: boolean;
};
type Page = { items: Account[]; total: number; page: number; pageSize: number };
const roles = { CUSTOMER: 'Cliente', ADMIN: 'Administrador', TECHNICIAN: 'Técnico' };
const date = (value: string) =>
  new Intl.DateTimeFormat('es-EC', { dateStyle: 'medium', timeZone: 'America/Guayaquil' }).format(
    new Date(value),
  );

/** Administración → Usuarios: búsqueda y paginación en el backend. Sin hashes ni tokens. */
export function AdminUsers() {
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Page | null>(null);
  const [error, setError] = useState('');
  // La búsqueda espera a que se deje de escribir y vuelve a la primera página.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearch(query.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    api<Page>(`admin/accounts?q=${encodeURIComponent(search)}&page=${page}&pageSize=20`, {
      signal: controller.signal,
    })
      .then(setData)
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [search, page]);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  return (
    <section className="team-admin">
      <h2>Usuarios</h2>
      <label className="admin-search">
        Buscar por nombre, teléfono o correo
        <input
          type="search"
          value={query}
          maxLength={100}
          placeholder="Ej.: Ana, 0991234567, ana@correo.com"
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      {error && (
        <p className="admin-message" role="alert">
          {error}
        </p>
      )}
      {!data && !error && <ListSkeleton label="Cargando usuarios…" count={3} />}
      {data && (
        <p className="small" role="status">
          {data.total === 1 ? '1 usuario' : `${data.total} usuarios`}
          {search && ` para «${search}»`}
        </p>
      )}
      {data?.items.length === 0 && <p className="tech-empty">No hay usuarios con esta búsqueda.</p>}
      <div className="team-list">
        {data?.items.map((u) => (
          <article
            key={u.id}
            className={`team-member ${u.active && !u.blocked ? '' : 'is-inactive'}`}
          >
            <div>
              <strong>{u.name}</strong>
              <p>
                {roles[u.role]} · {u.phone}
                {u.email ? ` · ${u.email}` : ''}
              </p>
              <p className="user-badges">
                <span className={u.phoneVerifiedAt ? 'verified' : 'unverified'}>
                  {u.phoneVerifiedAt ? '✓ WhatsApp verificado' : 'WhatsApp sin verificar'}
                </span>
                {u.email && (
                  <span className={u.emailVerifiedAt ? 'verified' : 'unverified'}>
                    {u.emailVerifiedAt ? '✓ Correo verificado' : 'Correo sin verificar'}
                  </span>
                )}
                <span>Registro: {date(u.createdAt)}</span>
                {u.role === 'CUSTOMER' && (
                  <span>{u.appointments === 1 ? '1 cita' : `${u.appointments} citas`}</span>
                )}
                {!u.active && <span className="unverified">Desactivado</span>}
                {u.blocked && <span className="unverified">Número bloqueado</span>}
              </p>
            </div>
          </article>
        ))}
      </div>
      {data && pages > 1 && (
        <nav className="admin-pager" aria-label="Páginas de usuarios">
          <button
            type="button"
            className="btn btn-ghost btn-small"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            ← Anterior
          </button>
          <span>
            Página {data.page} de {pages}
          </span>
          <button
            type="button"
            className="btn btn-ghost btn-small"
            disabled={page >= pages}
            onClick={() => setPage((p) => p + 1)}
          >
            Siguiente →
          </button>
        </nav>
      )}
    </section>
  );
}
