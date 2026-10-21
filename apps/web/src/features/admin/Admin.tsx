import { AdminEmail } from './AdminEmail';
import { AdminSlides } from './AdminSlides';
import { AdminAnalytics } from './AdminAnalytics';
import {
  offeringSchema,
  type AccountUser,
  type CatalogEquipment,
  type Offering,
  type ServiceCategory,
} from '@instafix/contracts';
import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../../lib/api';
import { Login } from '../account/Login';
import { emptyService, type ServiceDraft } from './admin.types';
import { AdminAppointments } from './AdminAppointments';
import { AdminEquipment } from './AdminEquipment';
import { AdminJobs } from './AdminJobs';
import { AdminServices } from './AdminServices';
import { AdminWarranty } from './AdminWarranty';
import { AdminWhatsApp } from './AdminWhatsApp';
import { AdminTeam } from './AdminTeam';
import { AdminUsers } from './AdminUsers';
import { AdminBlockedPhones } from './AdminBlockedPhones';
import { TechnicianPanel } from '../technician/TechnicianPanel';
import { ListSkeleton, Skeleton } from '../../components/ui/Skeleton';
export default function Admin() {
  const [user, setUser] = useState<AccountUser | null>(null);
  const [checking, setChecking] = useState(true);
  const [tab, setTab] = useState('Servicios');
  const [items, setItems] = useState<Offering[]>([]);
  const [equipment, setEquipment] = useState<CatalogEquipment[]>([]);
  const [categories, setCategories] = useState<ServiceCategory[]>([]);
  const [users, setUsers] = useState<AccountUser[]>([]);
  const [draft, setDraft] = useState<ServiceDraft>({ ...emptyService });
  const [policy, setPolicy] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  // Catálogo, equipos, clientes y política se cargan juntos; hasta entonces, skeletons.
  const [loaded, setLoaded] = useState(false);
  const update = <K extends keyof ServiceDraft>(key: K, value: ServiceDraft[K]) =>
    setDraft((previous) => ({ ...previous, [key]: value }));
  async function load() {
    const [services, devices, groups, customers, terms] = await Promise.all([
      api('admin/services'),
      api('equipment'),
      api('categories'),
      api('admin/users'),
      api('warranty-policy'),
    ]);
    setItems(services);
    setEquipment(devices);
    setCategories(groups);
    setUsers(customers);
    setPolicy(terms.text);
    setLoaded(true);
  }
  const [sessionError, setSessionError] = useState('');
  const checkSession = () => {
    setChecking(true);
    setSessionError('');
    api('auth/me')
      .then(setUser)
      .catch((e) => {
        // Sin sesión (401) se muestra el inicio de sesión; otros fallos se explican.
        if (!(e instanceof ApiError && e.status === 401)) setSessionError(e.message);
      })
      .finally(() => setChecking(false));
  };
  useEffect(checkSession, []);
  useEffect(() => {
    if (user?.role === 'ADMIN') load().catch((e) => setMessage(e.message));
  }, [user]);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setMessage('');
    try {
      await action();
      setMessage('Cambios guardados.');
    } catch (e: any) {
      setMessage(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (uploading) return;
    await run(async () => {
      const { id, ...rest } = draft;
      const data = offeringSchema.parse(rest);
      await api(id ? `admin/services/${id}` : 'admin/services', {
        method: id ? 'PATCH' : 'POST',
        body: JSON.stringify(data),
      });
      await load();
      setDraft({ ...emptyService });
    });
  }
  if (checking)
    return (
      <main className="admin-page">
        <div className="skeleton-row is-start admin-skeleton-tabs">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} width={96} height={38} radius={999} />
          ))}
        </div>
        <ListSkeleton label="Cargando administración…" count={3} />
      </main>
    );
  if (sessionError)
    return (
      <main className="account-panel">
        <p role="alert">{sessionError}</p>
        <button className="btn btn-primary" onClick={checkSession}>
          Reintentar
        </button>
      </main>
    );
  if (!user)
    return (
      <main>
        <Login admin onLogin={setUser} />
      </main>
    );
  const logout = () =>
    run(async () => {
      await api('auth/logout', { method: 'POST' });
      setUser(null);
    });
  // El técnico entra directamente a su panel: no ve opciones de administración deshabilitadas.
  if (user.role === 'TECHNICIAN')
    return (
      <>
        <header className="staff-header">
          <span className="brand">InstaFix · Técnicos</span>
          <button className="btn btn-ghost btn-small" onClick={logout}>
            Cerrar sesión
          </button>
        </header>
        <main>
          <TechnicianPanel user={user} />
        </main>
      </>
    );
  if (user.role !== 'ADMIN')
    return (
      <main className="account-panel">
        <h1>Acceso restringido</h1>
        <p>Tu cuenta no tiene permisos de administración.</p>
        <button
          className="btn btn-secondary"
          onClick={() =>
            run(async () => {
              await api('auth/logout', { method: 'POST' });
              setUser(null);
            })
          }
        >
          Cerrar sesión
        </button>
      </main>
    );
  return (
    <>
      <header className="staff-header">
        <a className="brand" href="#">
          InstaFix · Administración
        </a>
        <button className="btn btn-ghost btn-small" onClick={logout}>
          Cerrar sesión
        </button>
      </header>
      <main className="admin-page">
        <div className="filters">
          {[
            'Servicios',
            'Categorías y equipos',
            'Citas',
            'Panel técnico',
            'Equipo',
            'Usuarios',
            'Números',
            'WhatsApp',
            'Garantías',
            'Trabajos',
            'Presentaciones',
            'Estadísticas',
            'Correo',
          ].map((name) => (
            <button
              disabled={uploading}
              key={name}
              className={tab === name ? 'active' : ''}
              onClick={() => {
                setTab(name);
                setMessage('');
              }}
            >
              {name}
            </button>
          ))}
        </div>
        {message && (
          <p role="status" className="admin-message">
            {message}
          </p>
        )}
        {tab === 'Correo' && <AdminEmail />}
        {tab === 'Panel técnico' && <TechnicianPanel user={user} />}
        {tab === 'Equipo' && <AdminTeam />}
        {tab === 'Usuarios' && <AdminUsers />}
        {tab === 'Números' && <AdminBlockedPhones />}
        {tab === 'Presentaciones' && <AdminSlides onUploading={setUploading} />}
        {tab === 'Estadísticas' && <AdminAnalytics />}
        {tab === 'Citas' && <AdminAppointments services={items} />}
        {tab === 'WhatsApp' && <AdminWhatsApp />}
        {tab === 'Servicios' && (
          <AdminServices
            items={items}
            equipment={equipment}
            categories={categories}
            draft={draft}
            setDraft={setDraft}
            update={update}
            uploading={uploading}
            setUploading={setUploading}
            save={save}
            busy={busy}
            loading={!loaded}
          />
        )}
        {tab === 'Categorías y equipos' && (
          <AdminEquipment
            categories={categories}
            equipment={equipment}
            services={items}
            load={load}
            loading={!loaded}
          />
        )}
        {tab === 'Garantías' && (
          <AdminWarranty
            policy={policy}
            setPolicy={setPolicy}
            run={run}
            busy={busy}
            loading={!loaded}
          />
        )}
        {tab === 'Trabajos' && <AdminJobs items={items} users={users} run={run} busy={busy} />}
      </main>
    </>
  );
}
