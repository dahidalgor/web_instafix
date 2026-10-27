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
import { appointmentIdFromHash } from '@instafix/contracts/src/push';
import { AdminGiveaway } from './AdminGiveaway';
import { StaffShell } from '../../components/staff/StaffShell';
import { StaffSettings } from '../staff/StaffSettings';
import { TechnicianApp } from '../technician/TechnicianApp';
import {
  adminGroups,
  DEFAULT_ADMIN_TAB,
  isAdminTab,
  mobilePrimary,
  type AdminTab,
} from './admin-nav';

const TAB_KEY = 'instafix:admin-tab';
/** Última ventana abierta en este navegador (comodidad; sin ella se abre Citas). */
function savedTab(): AdminTab {
  try {
    const value = localStorage.getItem(TAB_KEY);
    return isAdminTab(value) ? value : DEFAULT_ADMIN_TAB;
  } catch {
    return DEFAULT_ADMIN_TAB;
  }
}
import { pushApi } from '../notifications/push-api';
import { browserEnv, disablePush, resyncPush } from '../notifications/push-client';
export default function Admin() {
  const [user, setUser] = useState<AccountUser | null>(null);
  const [checking, setChecking] = useState(true);
  const [tab, setTabState] = useState<AdminTab>(savedTab);
  const setTab = (next: AdminTab) => {
    setTabState(next);
    try {
      localStorage.setItem(TAB_KEY, next);
    } catch {
      // Sin almacenamiento: la ventana no se recuerda, nada más.
    }
  };
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
      api('admin/equipment'),
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
    if (user?.role !== 'ADMIN' && user?.role !== 'TECHNICIAN') return;
    // Renueva en silencio la suscripción push de este dispositivo (nunca pide permiso).
    resyncPush(browserEnv(), pushApi).catch(() => {});
    if (user.role === 'ADMIN') load().catch((e) => setMessage(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, user?.role]);
  // Enlace a una cita (#cita=<id>), p. ej. al tocar una notificación push.
  const [focusAppointment, setFocusAppointment] = useState<string | null>(() =>
    appointmentIdFromHash(window.location.hash),
  );
  useEffect(() => {
    const follow = () => {
      const id = appointmentIdFromHash(window.location.hash);
      if (id) setFocusAppointment(id);
    };
    // El service worker pide navegar a una ventana ya abierta sin recargarla.
    const fromWorker = (event: MessageEvent) => {
      const data = event.data as { type?: string; url?: string } | null;
      if (data?.type !== 'instafix:navigate' || typeof data.url !== 'string') return;
      const url = new URL(data.url, window.location.origin);
      if (url.origin !== window.location.origin) return;
      if (url.hash) window.location.hash = url.hash;
      follow();
    };
    window.addEventListener('hashchange', follow);
    navigator.serviceWorker?.addEventListener('message', fromWorker);
    return () => {
      window.removeEventListener('hashchange', follow);
      navigator.serviceWorker?.removeEventListener('message', fromWorker);
    };
  }, []);
  useEffect(() => {
    // En administración el enlace abre Citas; el técnico lo abre en su propio panel.
    if (focusAppointment && user?.role === 'ADMIN') setTab('citas');
  }, [focusAppointment, user?.role]);
  const appointmentFocused = () => {
    setFocusAppointment(null);
    // Se quita el hash para que recargar no vuelva a abrir la misma cita.
    history.replaceState(null, '', window.location.pathname + window.location.search);
  };
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
  /** Orden de los servicios de un equipo (arrastrar). La lista se recarga al terminar. */
  async function reorderServices(equipmentId: string, ids: string[]) {
    setMessage('');
    try {
      await api(`admin/equipment/${equipmentId}/services-order`, {
        method: 'PUT',
        body: JSON.stringify({ ids }),
      });
      await load();
      setMessage('Orden guardado; la web muestra los servicios en este orden.');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'No se pudo guardar el orden.');
      await load().catch(() => {});
    }
  }
  /** Devuelve si se eliminó (el editor cierra su confirmación solo entonces). */
  async function removeService(id: string) {
    setBusy(true);
    setMessage('');
    try {
      const result = await api<{ kept: boolean }>(`admin/services/${id}`, { method: 'DELETE' });
      await load();
      setDraft({ ...emptyService });
      setMessage(
        result.kept
          ? 'Servicio eliminado del catálogo. Las citas y trabajos anteriores lo conservan.'
          : 'Servicio eliminado.',
      );
      return true;
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'No se pudo eliminar el servicio');
      return false;
    } finally {
      setBusy(false);
    }
  }
  if (checking)
    return (
      <div className="admin-shell is-loading">
        <aside className="admin-sidebar" aria-hidden="true">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} width="100%" height={36} radius={10} />
          ))}
        </aside>
        <main className="admin-main">
          <Skeleton width={220} height={34} radius={10} />
          <ListSkeleton label="Cargando administración…" count={3} />
        </main>
      </div>
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
      // Un dispositivo sin sesión no debe seguir recibiendo avisos con datos de citas.
      await disablePush(browserEnv(), pushApi).catch(() => {});
      await api('auth/logout', { method: 'POST' });
      setUser(null);
    });
  // El técnico entra directamente a su panel: no ve opciones de administración deshabilitadas.
  if (user.role === 'TECHNICIAN')
    return (
      <TechnicianApp
        user={user}
        onUser={setUser}
        onLogout={logout}
        focusId={focusAppointment}
        onFocused={appointmentFocused}
      />
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
    <StaffShell
      area="Administración"
      user={user}
      groups={adminGroups}
      primary={mobilePrimary}
      accountTab="cuenta"
      tab={tab}
      locked={uploading}
      onLogout={logout}
      onSelect={(next) => {
        setTab(next);
        setMessage('');
      }}
      message={
        message && (
          <p role="status" className="admin-message">
            {message}
          </p>
        )
      }
    >
      {tab === 'correo' && <AdminEmail />}
      {tab === 'cuenta' && <StaffSettings user={user} onUser={setUser} onLogout={logout} />}
      {tab === 'sorteo' && <AdminGiveaway />}
      {tab === 'tecnico' && <TechnicianPanel user={user} embedded />}
      {tab === 'equipo' && <AdminTeam />}
      {tab === 'usuarios' && <AdminUsers currentUserId={user.id} />}
      {tab === 'numeros' && <AdminBlockedPhones />}
      {tab === 'presentaciones' && <AdminSlides onUploading={setUploading} />}
      {tab === 'estadisticas' && <AdminAnalytics />}
      {tab === 'citas' && (
        <AdminAppointments
          services={items}
          focusId={focusAppointment}
          onFocused={appointmentFocused}
        />
      )}
      {tab === 'whatsapp' && <AdminWhatsApp />}
      {tab === 'servicios' && (
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
          remove={removeService}
          reorder={reorderServices}
        />
      )}
      {tab === 'categorias' && (
        <AdminEquipment
          categories={categories}
          equipment={equipment}
          services={items}
          load={load}
          loading={!loaded}
        />
      )}
      {tab === 'garantias' && (
        <AdminWarranty
          policy={policy}
          setPolicy={setPolicy}
          run={run}
          busy={busy}
          loading={!loaded}
        />
      )}
      {tab === 'trabajos' && <AdminJobs items={items} users={users} run={run} busy={busy} />}
    </StaffShell>
  );
}
