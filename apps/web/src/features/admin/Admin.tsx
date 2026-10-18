import { AdminEmail } from './AdminEmail';
import { AdminSlides } from './AdminSlides';
import { AdminAnalytics } from './AdminAnalytics';
import { offeringSchema, type AccountUser, type Offering } from '@instafix/contracts';
import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../../lib/api';
import { Login } from '../account/Login';
import { emptyService, type Equipment, type ServiceDraft } from './admin.types';
import { AdminAppointments } from './AdminAppointments';
import { AdminEquipment } from './AdminEquipment';
import { AdminJobs } from './AdminJobs';
import { AdminServices } from './AdminServices';
import { AdminWarranty } from './AdminWarranty';
import { AdminWhatsApp } from './AdminWhatsApp';
import { AdminTeam } from './AdminTeam';
import { TechnicianPanel } from '../technician/TechnicianPanel';
export default function Admin() {
  const [user, setUser] = useState<AccountUser | null>(null);
  const [checking, setChecking] = useState(true);
  const [tab, setTab] = useState('Servicios');
  const [items, setItems] = useState<Offering[]>([]);
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [users, setUsers] = useState<AccountUser[]>([]);
  const [draft, setDraft] = useState<ServiceDraft>({ ...emptyService });
  const [policy, setPolicy] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const update = <K extends keyof ServiceDraft>(key: K, value: ServiceDraft[K]) =>
    setDraft((previous) => ({ ...previous, [key]: value }));
  async function load() {
    const [services, devices, customers, terms] = await Promise.all([
      api('admin/services'),
      api('equipment'),
      api('admin/users'),
      api('warranty-policy'),
    ]);
    setItems(services);
    setEquipment(devices);
    setUsers(customers);
    setPolicy(terms.text);
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
  if (checking) return <main>Cargando…</main>;
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
            'Equipos',
            'Citas',
            'Panel técnico',
            'Equipo',
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
        {tab === 'Presentaciones' && <AdminSlides onUploading={setUploading} />}
        {tab === 'Estadísticas' && <AdminAnalytics />}
        {tab === 'Citas' && <AdminAppointments services={items} />}
        {tab === 'WhatsApp' && <AdminWhatsApp />}
        {tab === 'Servicios' && (
          <AdminServices
            items={items}
            equipment={equipment}
            draft={draft}
            setDraft={setDraft}
            update={update}
            uploading={uploading}
            setUploading={setUploading}
            save={save}
            busy={busy}
          />
        )}
        {tab === 'Equipos' && (
          <AdminEquipment equipment={equipment} run={run} load={load} busy={busy} />
        )}
        {tab === 'Garantías' && (
          <AdminWarranty policy={policy} setPolicy={setPolicy} run={run} busy={busy} />
        )}
        {tab === 'Trabajos' && <AdminJobs items={items} users={users} run={run} busy={busy} />}
      </main>
    </>
  );
}
