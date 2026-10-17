import {
  appointmentLabels,
  type AccountUser,
  type Appointment,
  type CompletedJob,
} from '@instafix/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { money } from '../../lib/format';
import { AccountSecurity } from './AccountSecurity';
import { AppointmentActions } from './AppointmentActions';
import { Login } from './Login';

// Enlaces de correo: #restablecer?token=… y #verificar-correo?token=…
function linkToken(page: string) {
  const [path, query] = window.location.hash.replace(/^#/, '').split('?');
  return path === page ? new URLSearchParams(query || '').get('token') || '' : '';
}

export function AccountDashboard() {
  const loadRevision = useRef(0);
  const [user, setUser] = useState<AccountUser | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [sessionError, setSessionError] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [jobs, setJobs] = useState<CompletedJob[]>([]);
  const [section, setSection] = useState<'appointments' | 'jobs' | 'security'>('appointments');
  const [resetToken] = useState(() => linkToken('restablecer'));
  const [emailNotice, setEmailNotice] = useState('');
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
    const token = linkToken('verificar-correo');
    if (!token) {
      void loadSession();
      return;
    }
    // El enlace se consume una vez y se retira de la barra de direcciones.
    history.replaceState(null, '', '#cuenta');
    api<{ email: string }>('auth/email/verify', {
      method: 'POST',
      body: JSON.stringify({ token }),
    })
      .then(() => {
        setEmailNotice('✓ Tu correo quedó verificado.');
        setSection('security');
      })
      .catch((e) => setEmailNotice(e.message))
      .finally(() => void loadSession());
  }, [loadSession]);
  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!user) return;
      const revision = ++loadRevision.current;
      setLoading(true);
      setError('');
      try {
        const [nextAppointments, nextJobs] = await Promise.all([
          api<Appointment[]>('my/appointments', { signal }),
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
          setAppointments([]);
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
      if (document.visibilityState === 'visible') void load();
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
  if (resetToken || !user)
    return (
      <>
        {emailNotice && (
          <p role="status" className="account-banner">
            {emailNotice}
          </p>
        )}
        <Login
          resetToken={resetToken || undefined}
          onLogin={(next) => {
            setUser(next);
            if (resetToken) window.location.hash = '#cuenta';
          }}
        />
      </>
    );
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
      {emailNotice && (
        <p role="status" className="account-banner">
          {emailNotice}
        </p>
      )}
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
        <button aria-pressed={section === 'security'} onClick={() => setSection('security')}>
          Seguridad
        </button>
        <button className="refresh-account" disabled={loading} onClick={() => void load()}>
          Actualizar
        </button>
      </div>
      {section === 'security' ? (
        <AccountSecurity user={user} onUser={setUser} />
      ) : loading ? (
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
                Aquí aparecerán tus citas. Las reservas hechas como invitado con este mismo WhatsApp
                se añaden automáticamente al verificar tu número.
              </p>
              <a className="button" href="#agenda">
                Consultar horarios ↗
              </a>
            </div>
          )}
          {shown.map((item) => (
            <article className="history-card" key={item.id}>
              <span className="badge">{appointmentLabels[item.status]}</span>
              <p className="eyebrow">Solicitud</p>
              <h2>“{item.title}”</h2>
              {item.bookingIdentityIssue && (
                <p role="status" className="calendar-account-note">
                  Tu reserva está pendiente de revisión porque sus datos de contacto no coinciden
                  con tu cuenta. Contacta con InstaFix para corregirlos antes de confirmar la
                  visita.
                </p>
              )}
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
                  <dt>Fecha y hora estimada</dt>
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
              <AppointmentActions appointment={item} onChanged={() => void load()} />
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
