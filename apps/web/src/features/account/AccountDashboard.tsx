import {
  appointmentLabels,
  type AccountUser,
  type Appointment,
  type CompletedJob,
} from '@instafix/contracts';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { money } from '../../lib/format';
import { Login } from './Login';

export function AccountDashboard() {
  const [user, setUser] = useState<AccountUser | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [sessionError, setSessionError] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [jobs, setJobs] = useState<CompletedJob[]>([]);
  const [section, setSection] = useState<'appointments' | 'jobs'>('appointments');
  const [appointmentFilter, setAppointmentFilter] = useState('upcoming');
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
    async (signal?: AbortSignal) => {
      if (!user) return;
      setLoading(true);
      setError('');
      try {
        const [nextAppointments, nextJobs] = await Promise.all([
          api<Appointment[]>('my/appointments', { signal }),
          api<CompletedJob[]>('my/jobs', { signal }),
        ]);
        if (!signal?.aborted) {
          setAppointments(nextAppointments);
          setJobs(nextJobs);
        }
      } catch (e) {
        if (signal?.aborted) return;
        if (e instanceof ApiError && e.status === 401) {
          setUser(null);
          setAppointments([]);
          setJobs([]);
        } else setError('No pudimos cargar tus citas y servicios. Puedes volver a intentarlo.');
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [user],
  );
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);
  async function logout() {
    setLoggingOut(true);
    setError('');
    try {
      await api('auth/logout', { method: 'POST' });
      setUser(null);
      setAppointments([]);
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
  if (!user) return <Login onLogin={setUser} />;
  const upcoming = appointments.filter(
    (item) =>
      !['CANCELLED', 'COMPLETED'].includes(item.status) && new Date(item.endsAt).getTime() >= now,
  );
  const shown =
    appointmentFilter === 'upcoming'
      ? upcoming
      : appointments.filter((item) => !upcoming.includes(item)).reverse();
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
          <strong>{loading || error ? '—' : upcoming.length}</strong>
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
        <>
          <div className="filters">
            <button
              aria-pressed={appointmentFilter === 'upcoming'}
              className={appointmentFilter === 'upcoming' ? 'active' : ''}
              onClick={() => setAppointmentFilter('upcoming')}
            >
              Próximas
            </button>
            <button
              aria-pressed={appointmentFilter === 'past'}
              className={appointmentFilter === 'past' ? 'active' : ''}
              onClick={() => setAppointmentFilter('past')}
            >
              Historial
            </button>
          </div>
          {!shown.length && (
            <div className="empty-account">
              <h2>
                {appointmentFilter === 'upcoming'
                  ? 'No tienes citas próximas'
                  : 'Tu historial comienza aquí'}
              </h2>
              <p>
                Aquí aparecerán las citas que Instafix haya vinculado a tu cuenta. Si reservaste
                como invitado, solicita la vinculación a nuestro equipo.
              </p>
              <a className="button" href="#agenda">
                Consultar horarios ↗
              </a>
            </div>
          )}
          {shown.map((item) => (
            <article className="history-card" key={item.id}>
              <span className="badge">{appointmentLabels[item.status]}</span>
              <p className="eyebrow">{item.device}</p>
              <h2>{item.title}</h2>
              <dl className="appointment-details">
                <div>
                  <dt>Servicio asignado por el técnico</dt>
                  <dd>
                    {item.assignedService
                      ? `${item.assignedService.device} · ${item.assignedService.title}`
                      : 'Pendiente de diagnóstico'}
                  </dd>
                </div>
                <div>
                  <dt>Inicio</dt>
                  <dd>{format(item.startsAt, item.timeZone)}</dd>
                </div>
                <div>
                  <dt>Fin estimado</dt>
                  <dd>{format(item.endsAt, item.timeZone)}</dd>
                </div>
                <div>
                  <dt>Zona horaria</dt>
                  <dd>{item.timeZone}</dd>
                </div>
                <div>
                  <dt>Técnico</dt>
                  <dd>{item.technician || 'Por asignar'}</dd>
                </div>
                <div>
                  <dt>Dirección</dt>
                  <dd>{item.address || 'Pendiente de ubicación'}</dd>
                </div>
              </dl>
              <p className="small">Referencia: {item.id}</p>
              <a className="text-button" href="#solicitud">
                Consultar sobre mi cita →
              </a>
            </article>
          ))}
        </>
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
