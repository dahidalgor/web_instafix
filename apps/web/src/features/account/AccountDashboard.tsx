import { type AccountUser, type CompletedJob } from '@instafix/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { money } from '../../lib/format';
import { Login } from './Login';
import { MyAppointments, type MyAppointmentsData } from './MyAppointments';

export function AccountDashboard() {
  const loadRevision = useRef(0);
  const [user, setUser] = useState<AccountUser | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [sessionError, setSessionError] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [appointments, setAppointments] = useState<MyAppointmentsData>({
    upcoming: [],
    history: [],
  });
  const [jobs, setJobs] = useState<CompletedJob[]>([]);
  const [section, setSection] = useState<'appointments' | 'jobs'>('appointments');
  const [loggingOut, setLoggingOut] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);
  const loadSession = useCallback(async () => {
    setSessionLoading(true);
    setSessionError('');
    try {
      setUser(await api<AccountUser>('auth/me'));
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401))
        setSessionError('No pudimos conectar con tu cuenta.');
    } finally {
      setSessionLoading(false);
    }
  }, []);
  useEffect(() => {
    void loadSession();
  }, [loadSession]);
  const load = useCallback(
    async (signal?: AbortSignal, silent = false) => {
      if (!user) return;
      const revision = ++loadRevision.current;
      // Tras cancelar o reprogramar se actualiza sin ocultar la lista.
      if (!silent) setLoading(true);
      setError('');
      try {
        const [nextAppointments, nextJobs] = await Promise.all([
          // Citas del usuario de la sesión, ya separadas por el servidor.
          api<MyAppointmentsData>('appointments/me', { signal }),
          api<CompletedJob[]>('my/jobs', { signal }),
        ]);
        if (!signal?.aborted && revision === loadRevision.current) {
          setAppointments(nextAppointments);
          setJobs(nextJobs);
        }
      } catch (e) {
        if (signal?.aborted || revision !== loadRevision.current) return;
        if (e instanceof ApiError && e.status === 401) {
          setUser(null);
          setAppointments({ upcoming: [], history: [] });
          setJobs([]);
        } else setError('No pudimos cargar tus citas y servicios. Puedes volver a intentarlo.');
      } finally {
        if (!signal?.aborted && revision === loadRevision.current) setLoading(false);
      }
    },
    [user],
  );
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => {
      controller.abort();
      loadRevision.current++;
    };
  }, [load]);
  useEffect(() => {
    if (!user) return;
    const refresh = () => {
      if (document.visibilityState === 'visible') void load(undefined, true);
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [user, load]);
  async function logout() {
    setLoggingOut(true);
    setError('');
    try {
      await api('auth/logout', { method: 'POST' });
      loadRevision.current++;
      setUser(null);
      setAppointments({ upcoming: [], history: [] });
      setJobs([]);
    } catch {
      setError('No se pudo cerrar la sesión. Inténtalo nuevamente.');
    } finally {
      setLoggingOut(false);
    }
  }
  if (sessionLoading)
    return (
      <p className="account-panel" role="status">
        Cargando tu cuenta…
      </p>
    );
  if (sessionError)
    return (
      <section className="account-panel">
        <p role="alert">{sessionError}</p>
        <button onClick={loadSession}>Reintentar</button>
      </section>
    );
  if (!user)
    return (
      <Login
        onLogin={(next) => {
          setUser(next);
          // Si el inicio de sesión vino desde la agenda, se vuelve a ella con el borrador.
          try {
            const target = sessionStorage.getItem('instafix:return-to');
            sessionStorage.removeItem('instafix:return-to');
            if (target === '#agenda') window.location.hash = target;
          } catch {
            // Sin almacenamiento: el usuario permanece en Mi cuenta.
          }
        }}
      />
    );
  const activeWarranties = jobs.filter(
    (job) => job.warrantyEndsAt && new Date(job.warrantyEndsAt).getTime() > now,
  ).length;
  const format = (date: string, timeZone = 'America/Guayaquil') =>
    new Intl.DateTimeFormat('es-EC', { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(
      new Date(date),
    );
  return (
    <section className="account-panel wide">
      <div className="account-heading">
        <div>
          <p className="eyebrow">TU ESPACIO INSTAFIX</p>
          <h1>Hola, {user.name}</h1>
          <p>{user.phone}</p>
        </div>
        <button className="text-button" disabled={loggingOut} onClick={logout}>
          {loggingOut ? 'Cerrando…' : 'Cerrar sesión'}
        </button>
      </div>
      <div className="account-summary">
        <div>
          <strong>{loading || error ? '—' : appointments.upcoming.length}</strong>
          <span>Citas próximas</span>
        </div>
        <div>
          <strong>{loading || error ? '—' : jobs.length}</strong>
          <span>Servicios realizados</span>
        </div>
        <div>
          <strong>{loading || error ? '—' : activeWarranties}</strong>
          <span>Garantías vigentes</span>
        </div>
      </div>
      <div className="account-tabs" role="group" aria-label="Contenido de mi cuenta">
        <button
          aria-pressed={section === 'appointments'}
          onClick={() => setSection('appointments')}
        >
          Mis citas
        </button>
        <button aria-pressed={section === 'jobs'} onClick={() => setSection('jobs')}>
          Servicios y garantías
        </button>
        <button className="refresh-account" disabled={loading} onClick={() => void load()}>
          Actualizar
        </button>
      </div>
      {loading ? (
        <p role="status">Cargando tus datos…</p>
      ) : error ? (
        <p role="alert">
          {error} <button onClick={() => void load()}>Reintentar</button>
        </p>
      ) : section === 'appointments' ? (
        <MyAppointments data={appointments} onChanged={() => load(undefined, true)} />
      ) : (
        <>
          {!jobs.length && (
            <div className="empty-account">
              <h2>Aún no hay servicios realizados</h2>
              <p>
                Cuando finalice un trabajo vinculado a tu cuenta, verás aquí su importe y las
                condiciones de garantía.
              </p>
              <a className="text-button" href="#servicios">
                Explorar servicios →
              </a>
            </div>
          )}
          {jobs.map((job) => {
            const expires = job.warrantyEndsAt ? new Date(job.warrantyEndsAt).getTime() : null;
            const days = expires ? Math.max(0, Math.ceil((expires - now) / 86400000)) : 0;
            return (
              <article className="history-card" key={job.id}>
                <p className="eyebrow">{job.device}</p>
                <h2>{job.title}</h2>
                <p>
                  {format(job.completedAt)} · {money(job.priceMinor)}
                </p>
                <strong>
                  {expires === null
                    ? 'Sin garantía registrada'
                    : days
                      ? `Garantía vigente · ${days} días restantes`
                      : 'Garantía vencida'}
                </strong>
                {job.warrantyEndsAt && <p>Vence: {format(job.warrantyEndsAt)}</p>}
                <p className="service-description">
                  {job.warrantyTerms || 'Consulta las condiciones con Instafix.'}
                </p>
                <a className="text-button" href="#garantia">
                  Políticas de garantía →
                </a>
              </article>
            );
          })}
        </>
      )}
    </section>
  );
}
