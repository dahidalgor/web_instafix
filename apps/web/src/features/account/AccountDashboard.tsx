import {
  AppointmentCardSkeleton,
  ListSkeleton,
  Skeleton,
  SkeletonGroup,
  StatTilesSkeleton,
} from '../../components/ui/Skeleton';
import {
  entriesLabel,
  giveawayIsOpen,
  type AccountUser,
  type Appointment,
  type CompletedJob,
} from '@instafix/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { usePaged } from '../../lib/paged';
import { LoadMore } from '../../components/ui/LoadMore';

/** Encabezado de Mi cuenta (lo calcula el servidor). */
type AccountSummary = {
  upcoming: number;
  servicesDone: number;
  activeWarranties: number;
  giveaway: {
    id: string;
    prize: string;
    drawDate: string;
    entryRule: string;
    entries: number;
  } | null;
};
import { money } from '../../lib/format';
import { LOGOUT_EVENT } from '../../components/layout/AccountMenu';
import { linkToken } from './account-links';
import { AppointmentActions } from './AppointmentActions';
import { AppointmentCard } from '../../components/appointments/AppointmentCard';
import { AppointmentLocation } from '../../components/appointments/AppointmentLocation';
import { Login } from './Login';

export function AccountDashboard() {
  const loadRevision = useRef(0);
  const [user, setUser] = useState<AccountUser | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [sessionError, setSessionError] = useState('');
  // true desde el inicio: antes de la primera respuesta no se muestra el estado vacío.
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // Citas próximas (pocas, todas) y el resumen del encabezado. El historial y los servicios
  // realizados se cargan aparte, de 10 en 10, solo al abrir esa sección.
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [summary, setSummary] = useState<AccountSummary | null>(null);
  const [section, setSection] = useState<'appointments' | 'jobs'>('appointments');
  const [resetToken] = useState(() => linkToken('restablecer'));
  const [appointmentFilter, setAppointmentFilter] = useState('upcoming');
  const [now, setNow] = useState(Date.now());
  const past = usePaged<Appointment>(
    user && section === 'appointments' && appointmentFilter === 'past'
      ? 'my/appointments?scope=past&pageSize=10'
      : null,
  );
  const jobsPage = usePaged<CompletedJob>(
    user && section === 'jobs' ? 'my/jobs?pageSize=10' : null,
  );
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
      // 401 = sin sesión (se muestra el inicio de sesión). Cualquier otro fallo se explica tal
      // cual: sin conexión, error del servidor o cuenta desactivada.
      if (!(e instanceof ApiError && e.status === 401))
        setSessionError(e instanceof Error ? e.message : 'No pudimos conectar con tu cuenta.');
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
      const revision = ++loadRevision.current;
      setLoading(true);
      setError('');
      try {
        const [nextAppointments, nextSummary] = await Promise.all([
          api<{ items: Appointment[] }>('my/appointments?scope=upcoming', { signal }),
          api<AccountSummary>('my/summary', { signal }),
        ]);
        if (!signal?.aborted && revision === loadRevision.current) {
          setAppointments(nextAppointments.items);
          setSummary(nextSummary);
        }
      } catch (e) {
        if (signal?.aborted || revision !== loadRevision.current) return;
        if (e instanceof ApiError && e.status === 401) {
          setUser(null);
          setAppointments([]);
          setSummary(null);
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
  // Cierre de sesión desde el menú de usuario del encabezado.
  useEffect(() => {
    const signedOut = () => {
      loadRevision.current++;
      setUser(null);
      setAppointments([]);
      setSummary(null);
    };
    window.addEventListener(LOGOUT_EVENT, signedOut);
    return () => window.removeEventListener(LOGOUT_EVENT, signedOut);
  }, []);
  if (sessionLoading)
    return (
      <section className="account-panel wide">
        <SkeletonGroup label="Cargando tu cuenta…">
          <Skeleton width={150} height={14} />
          <Skeleton width="min(420px, 80%)" height={44} className="skeleton-heading" />
          <Skeleton width={140} height={14} />
        </SkeletonGroup>
        <div className="account-summary">
          <StatTilesSkeleton />
        </div>
        <div className="appt-list">
          <AppointmentCardSkeleton />
          <AppointmentCardSkeleton />
        </div>
      </section>
    );
  if (sessionError)
    return (
      <section className="account-panel">
        <p role="alert">{sessionError}</p>
        <button className="btn btn-primary" onClick={loadSession}>
          Reintentar
        </button>
      </section>
    );
  if (resetToken || !user)
    return (
      <Login
        resetToken={resetToken || undefined}
        onLogin={(next) => {
          setUser(next);
          if (resetToken) window.location.hash = '#cuenta';
        }}
      />
    );
  const upcoming = appointments.filter(
    (item) =>
      !['CANCELLED', 'COMPLETED'].includes(item.status) && new Date(item.endsAt).getTime() >= now,
  );
  const pastItems = past.items ?? [];
  const jobs = jobsPage.items ?? [];
  const shown = appointmentFilter === 'upcoming' ? upcoming : pastItems;
  // Números del encabezado y sorteo abierto: los calcula el servidor (sin traer el historial).
  const servicesDone = summary?.servicesDone ?? 0;
  const activeWarranties = summary?.activeWarranties ?? 0;
  const openGiveaway = summary?.giveaway ?? null;
  const giveawayTotal = openGiveaway?.entries ?? 0;
  // Etiqueta en cada servicio que participa en un sorteo abierto (se oculta al cerrarse).
  const inOpenGiveaway = (job: CompletedJob) =>
    Boolean(
      job.giveaway && (job.giveawayEntries ?? 0) > 0 && giveawayIsOpen(job.giveaway, new Date(now)),
    );
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
        <a className="btn btn-ghost btn-small" href="#ajustes">
          Ajustes de la cuenta
        </a>
      </div>
      <div className="account-summary">
        {loading ? (
          <StatTilesSkeleton />
        ) : (
          <>
            <div>
              <strong>{error ? '—' : (summary?.upcoming ?? upcoming.length)}</strong>
              <span>Citas próximas</span>
            </div>
            <div>
              <strong>{error ? '—' : servicesDone}</strong>
              <span>Servicios realizados</span>
            </div>
            <div>
              <strong>{error ? '—' : activeWarranties}</strong>
              <span>Garantías vigentes</span>
            </div>
          </>
        )}
      </div>
      {!loading && !error && openGiveaway && giveawayTotal > 0 && (
        <div className="giveaway-banner">
          <strong>
            {entriesLabel(giveawayTotal)} por {openGiveaway.prize}
          </strong>
          <span>
            Sorteo el {giveawayDay(openGiveaway.drawDate)}. {openGiveaway.entryRule}
          </span>
        </div>
      )}
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
      </div>
      {/* Cambiar de sección o de filtro anima el contenido, como la navegación de la página. */}
      <div className="account-section" key={`${section}-${appointmentFilter}`}>
        {loading ||
        (section === 'appointments' && appointmentFilter === 'past' && past.items === null) ||
        (section === 'jobs' && jobsPage.items === null) ? (
          section === 'appointments' ? (
            <div className="appt-list">
              <ListSkeleton label="Cargando tus citas…" count={2} variant="appointment" />
            </div>
          ) : (
            <ListSkeleton label="Cargando tus servicios…" count={2} />
          )
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
                  Aquí aparecerán tus citas. Las reservas hechas como invitado con este mismo
                  WhatsApp se añaden automáticamente al verificar tu número.
                </p>
                <a className="button" href="#agenda">
                  Consultar horarios ↗
                </a>
              </div>
            )}
            <div className="appt-list">
              {shown.map((item) => (
                <AppointmentCard
                  key={item.id}
                  status={item.status}
                  startsAt={item.startsAt}
                  timeZone={item.timeZone}
                  request={item.title}
                  technician={item.assignedTechnician?.name || item.technician || null}
                  details={
                    <>
                      {item.status !== 'CANCELLED' || item.locationReceivedAt ? (
                        <AppointmentLocation
                          appointment={item}
                          pending="Pendiente: envíanos tu ubicación por WhatsApp"
                        />
                      ) : null}
                      {item.status === 'CANCELLED' && item.autoCancelReason && (
                        <div className="appt-meta-wide">
                          <dt>Cancelada automáticamente</dt>
                          <dd>
                            {item.autoCancelReason.includes('cliente no respondió')
                              ? 'No recibimos tu respuesta por WhatsApp a tiempo y el horario quedó libre.'
                              : 'No pudimos confirmarla a tiempo y el horario quedó libre.'}{' '}
                            Puedes agendar otra cita cuando quieras.
                          </dd>
                        </div>
                      )}
                      {!!item.services?.length && (
                        <div className="appt-meta-wide">
                          <dt>Servicios realizados</dt>
                          <dd>
                            <ul className="performed-list">
                              {item.services.map((service) => (
                                <li key={service.id}>
                                  {service.nameSnapshot}
                                  {service.quantity > 1 ? ` ×${service.quantity}` : ''}
                                </li>
                              ))}
                            </ul>
                          </dd>
                        </div>
                      )}
                    </>
                  }
                >
                  {item.status === 'PENDING_LOCATION' && (
                    <p className="appt-hint">
                      Recibimos tu solicitud. Te avisaremos cuando un técnico confirme tu visita.
                    </p>
                  )}
                  {item.bookingIdentityIssue && (
                    <p role="status" className="calendar-account-note">
                      Tu reserva está pendiente de revisión porque sus datos de contacto no
                      coinciden con tu cuenta. Contacta con InstaFix para corregirlos antes de
                      confirmar la visita.
                    </p>
                  )}
                  <AppointmentActions appointment={item} onChanged={() => void load()} />
                </AppointmentCard>
              ))}
            </div>
            {appointmentFilter === 'past' && (
              <LoadMore
                shown={pastItems.length}
                total={past.total}
                loading={past.loading}
                onMore={() => void past.loadMore()}
                noun="citas"
              />
            )}
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
                <a className="btn btn-secondary" href="#servicios">
                  Explorar servicios
                </a>
              </div>
            )}
            {jobs.map((job) => {
              const done = new Date(job.completedAt).getTime();
              const expires = job.warrantyEndsAt ? new Date(job.warrantyEndsAt).getTime() : null;
              const days = expires ? Math.max(0, Math.ceil((expires - now) / 86400000)) : 0;
              const state = expires === null ? 'none' : days ? 'active' : 'expired';
              // Parte de la garantía que queda (barra), entre la fecha del trabajo y su vencimiento.
              const left =
                expires && expires > done
                  ? Math.min(100, Math.max(0, ((expires - now) / (expires - done)) * 100))
                  : 0;
              return (
                <article className={`history-card job-card is-${state}`} key={job.id}>
                  <div className="job-card-head">
                    <div>
                      <p className="eyebrow">{job.device}</p>
                      <h2>{job.title}</h2>
                      <p className={`warranty-label is-${state}`}>
                        {state === 'active'
                          ? 'Garantía vigente'
                          : state === 'expired'
                            ? 'Garantía vencida'
                            : 'Sin garantía'}
                      </p>
                      {inOpenGiveaway(job) && (
                        <p
                          className="giveaway-badge"
                          aria-label={`Participando por ${job.giveaway!.prize}: ${entriesLabel(job.giveawayEntries ?? 0)}`}
                        >
                          Participando por {job.giveaway!.prize}
                          {(job.giveawayEntries ?? 0) > 1 && (
                            <span className="giveaway-count">×{job.giveawayEntries}</span>
                          )}
                        </p>
                      )}
                    </div>
                    {state !== 'none' && <WarrantyRing left={left} days={days} />}
                  </div>
                  <dl className="job-card-facts">
                    <div>
                      <dt>Realizado</dt>
                      <dd>{dateOnly(job.completedAt)}</dd>
                    </div>
                    <div>
                      <dt>Importe</dt>
                      <dd>{money(job.priceMinor)}</dd>
                    </div>
                    <div>
                      <dt>Garantía hasta</dt>
                      <dd>{job.warrantyEndsAt ? dateOnly(job.warrantyEndsAt) : '—'}</dd>
                    </div>
                  </dl>
                  <details className="job-card-terms">
                    <summary>Condiciones de garantía</summary>
                    <p className="service-description">
                      {job.warrantyTerms || 'Consulta las condiciones con Instafix.'}
                    </p>
                    <a className="text-button" href="#garantia">
                      Ver políticas de garantía
                    </a>
                  </details>
                </article>
              );
            })}
            <LoadMore
              shown={jobs.length}
              total={jobsPage.total}
              loading={jobsPage.loading}
              onMore={() => void jobsPage.loadMore()}
              noun="servicios"
            />
          </>
        )}
      </div>
    </section>
  );
}

/** Anillo de garantía restante: se va vaciando hasta el vencimiento. */
function WarrantyRing({ left, days }: { left: number; days: number }) {
  const radius = 26;
  const length = 2 * Math.PI * radius;
  const tone = !days ? 'expired' : left <= 20 ? 'low' : 'ok';
  return (
    <div
      className={`warranty-ring is-${tone}`}
      role="img"
      aria-label={days ? `Garantía restante: ${Math.round(left)} %` : 'Garantía vencida'}
    >
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <circle className="warranty-ring-track" cx="32" cy="32" r={radius} />
        <circle
          className="warranty-ring-value"
          cx="32"
          cy="32"
          r={radius}
          strokeDasharray={length}
          strokeDashoffset={length * (1 - left / 100)}
        />
      </svg>
      <span aria-hidden="true">
        <strong>{days}</strong>
        {days === 1 ? 'día' : 'días'}
      </span>
    </div>
  );
}

/** Día del sorteo para mostrar («18 de noviembre»). */
const giveawayDay = (drawDate: string) =>
  new Intl.DateTimeFormat('es-EC', {
    timeZone: 'America/Guayaquil',
    day: 'numeric',
    month: 'long',
  }).format(new Date(`${drawDate}T12:00:00-05:00`));

/** Fecha sin hora (servicios y garantías). */
const dateOnly = (value: string) =>
  new Intl.DateTimeFormat('es-EC', {
    timeZone: 'America/Guayaquil',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(value));
