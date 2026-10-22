import { useEffect, useState } from 'react';
import { BusyButton } from '../../components/ui/BusyButton';
import { ListSkeleton } from '../../components/ui/Skeleton';
import { api } from '../../lib/api';

type Role = 'CUSTOMER' | 'ADMIN' | 'TECHNICIAN';
type Account = {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  role: Role;
  active: boolean;
  phoneVerifiedAt: string | null;
  emailVerifiedAt: string | null;
  createdAt: string;
  appointments: number;
  blocked: boolean;
};
type Page = { items: Account[]; total: number; page: number; pageSize: number };
const roles: Record<Role, string> = {
  CUSTOMER: 'Cliente',
  ADMIN: 'Administrador',
  TECHNICIAN: 'Técnico',
};
const roleFilters: { id: '' | Role; label: string }[] = [
  { id: '', label: 'Todos' },
  { id: 'CUSTOMER', label: 'Clientes' },
  { id: 'TECHNICIAN', label: 'Técnicos' },
  { id: 'ADMIN', label: 'Administradores' },
];
const date = (value: string) =>
  new Intl.DateTimeFormat('es-EC', { dateStyle: 'medium', timeZone: 'America/Guayaquil' }).format(
    new Date(value),
  );

/**
 * Administración → Usuarios: búsqueda, filtro por rol y paginación en el backend.
 * Eliminar pide confirmación; la API impide eliminar la propia cuenta. Sin hashes ni tokens.
 */
export function AdminUsers({ currentUserId }: { currentUserId: string }) {
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [role, setRole] = useState<'' | Role>('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Page | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirming, setConfirming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
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
    const params = new URLSearchParams({ q: search, role, page: String(page), pageSize: '20' });
    api<Page>(`admin/accounts?${params}`, { signal: controller.signal })
      .then(setData)
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [search, role, page, reload]);
  const chooseRole = (value: '' | Role) => {
    setRole(value);
    setPage(1);
    setConfirming(null);
  };
  async function remove(user: Account) {
    setDeleting(user.id);
    setNotice('');
    setError('');
    try {
      const result = await api<{ anonymized: boolean }>(`admin/accounts/${user.id}`, {
        method: 'DELETE',
      });
      setNotice(
        result.anonymized
          ? `Cuenta de ${user.name} eliminada. Sus citas y trabajos se conservan en el historial.`
          : `Cuenta de ${user.name} eliminada.`,
      );
      setConfirming(null);
      // Si era el último de la página, se vuelve a la anterior.
      if (data && data.items.length === 1 && page > 1) setPage((p) => p - 1);
      else setReload((n) => n + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo eliminar la cuenta');
    } finally {
      setDeleting(null);
    }
  }
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const filterLabel = roleFilters.find((r) => r.id === role)?.label.toLowerCase();
  return (
    <section className="team-admin">
      <h2>Usuarios</h2>
      <div className="admin-toolbar" role="search" aria-label="Buscar usuarios">
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
        <div className="filters" role="group" aria-label="Tipo de usuario">
          {roleFilters.map((option) => (
            <button
              key={option.id || 'all'}
              type="button"
              aria-pressed={role === option.id}
              className={role === option.id ? 'active' : ''}
              onClick={() => chooseRole(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      {error && (
        <p className="admin-message" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="admin-message" role="status">
          {notice}
        </p>
      )}
      {!data && !error && <ListSkeleton label="Cargando usuarios…" count={3} />}
      {data && (
        <p className="small" role="status">
          {data.total === 1 ? '1 usuario' : `${data.total} usuarios`}
          {role && ` (${filterLabel})`}
          {search && ` para «${search}»`}
        </p>
      )}
      {data?.items.length === 0 && <p className="tech-empty">No hay usuarios con este filtro.</p>}
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
            {u.id === currentUserId ? (
              <span className="small">Tu cuenta</span>
            ) : confirming === u.id ? (
              <div
                className="security-panel user-delete-confirm"
                role="alertdialog"
                aria-labelledby={`delete-user-${u.id}`}
              >
                <p id={`delete-user-${u.id}`}>
                  <strong>¿Eliminar la cuenta de {u.name}?</strong> No podrá volver a iniciar
                  sesión. Sus citas y trabajos se conservan en el historial; el teléfono y el correo
                  quedan libres. No se puede deshacer.
                </p>
                <div className="confirm-actions">
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={deleting === u.id}
                    onClick={() => setConfirming(null)}
                  >
                    Mantener
                  </button>
                  <BusyButton
                    type="button"
                    className="btn btn-danger"
                    busy={deleting === u.id}
                    busyLabel="Eliminando…"
                    onClick={() => void remove(u)}
                  >
                    Sí, eliminar
                  </BusyButton>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="btn btn-danger btn-small"
                disabled={deleting !== null}
                onClick={() => {
                  setConfirming(u.id);
                  setNotice('');
                }}
              >
                Eliminar
              </button>
            )}
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
