import { BusyButton } from '../../components/ui/BusyButton';
import { ListSkeleton } from '../../components/ui/Skeleton';
import type { AccountUser, Offering, StaffAppointment } from '@instafix/contracts';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppointmentCard, visitDayKey } from '../../components/appointments/AppointmentCard';
import { api, ApiError } from '../../lib/api';
import { AppointmentSheet } from './AppointmentSheet';

type Tab = 'today' | 'upcoming' | 'pending' | 'history';
const active = (a: StaffAppointment) => a.status === 'CONFIRMED' || a.status === 'IN_PROGRESS';

/** Agrupa «Mis citas»: Hoy (próxima primero, y visitas pasadas sin completar), Próximas e Historial. */
export function groupMine(items: StaffAppointment[], now = Date.now()) {
  const today = visitDayKey(now);
  const byStart = (a: StaffAppointment, b: StaffAppointment) =>
    new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime();
  const todayList = items
    .filter(
      (a) =>
        (active(a) && visitDayKey(a.startsAt) <= today) ||
        (a.status === 'COMPLETED' && visitDayKey(a.startsAt) === today),
    )
    .sort(
      (a, b) =>
        Number(a.status === 'COMPLETED') - Number(b.status === 'COMPLETED') || byStart(a, b),
    );
  const upcoming = items.filter((a) => active(a) && visitDayKey(a.startsAt) > today).sort(byStart);
  const history = items
    .filter((a) => !todayList.includes(a) && !upcoming.includes(a))
    .sort((a, b) => byStart(b, a));
  return { today: todayList, upcoming, history };
}

export function TechnicianPanel({ user }: { user: AccountUser }) {
  const [tab, setTab] = useState<Tab>('today');
  const [mine, setMine] = useState<StaffAppointment[]>([]);
  const [pending, setPending] = useState<StaffAppointment[]>([]);
  const [catalog, setCatalog] = useState<Offering[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  const load = useCallback(async () => {
    setError('');
    try {
      const [nextMine, nextPending] = await Promise.all([
        api<StaffAppointment[]>('staff/appointments/me'),
        api<StaffAppointment[]>('staff/appointments/pending'),
      ]);
      setMine(nextMine);
      setPending(nextPending);
      setNow(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No pudimos cargar tus citas.');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
    api<Offering[]>('catalog')
      .then(setCatalog)
      .catch(() => {});
    // Se actualiza al volver a la app (el técnico suele cambiar de aplicación en la calle).
    const refresh = () => document.visibilityState === 'visible' && void load();
    const timer = window.setInterval(refresh, 60000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [load]);

  const groups = useMemo(() => groupMine(mine, now), [mine, now]);
  const nextVisit = groups.today.find((a) => active(a) && new Date(a.endsAt).getTime() > now);

  async function confirm(id: string) {
    setBusyId(id);
    setNotice('');
    try {
      await api(`staff/appointments/${id}/confirm`, { method: 'POST' });
      setNotice('✓ Cita confirmada. Ya está en tus citas.');
      await load();
    } catch (e) {
      setNotice(e instanceof ApiError ? e.message : 'No se pudo confirmar la cita.');
      await load();
    } finally {
      setBusyId(null);
    }
  }

  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: 'today', label: 'Hoy', count: groups.today.filter(active).length },
    { id: 'upcoming', label: 'Próximas', count: groups.upcoming.length },
    { id: 'pending', label: 'Pendientes', count: pending.length },
    { id: 'history', label: 'Historial' },
  ];
  const list = tab === 'pending' ? pending : tab === 'today' ? groups.today : groups[tab];
  const empty: Record<Tab, string> = {
    today: 'No tienes visitas para hoy.',
    upcoming: 'No tienes visitas próximas confirmadas.',
    pending: 'No hay citas pendientes de confirmar. ¡Buen trabajo!',
    history: 'Aún no hay visitas en tu historial.',
  };

  return (
    <section className="tech-panel">
      {/* Con el detalle abierto, el resto queda inerte: ni foco ni lector de pantalla detrás. */}
      <div inert={openId ? true : undefined}>
        <div className="tech-hero">
          <p className="eyebrow">PANEL TÉCNICO</p>
          <h1>Hola, {user.firstName || user.name.split(' ')[0]}</h1>
          {nextVisit ? (
            <p>
              Próxima visita: <strong>{nextVisit.contactName}</strong> a las{' '}
              <strong>
                {new Intl.DateTimeFormat('es-EC', {
                  hour: '2-digit',
                  minute: '2-digit',
                  hourCycle: 'h23',
                  timeZone: nextVisit.timeZone,
                }).format(new Date(nextVisit.startsAt))}
              </strong>
            </p>
          ) : (
            <p>
              {pending.length ? `${pending.length} citas esperan confirmación.` : 'Todo al día.'}
            </p>
          )}
        </div>

        <nav className="tech-tabs" aria-label="Secciones del panel técnico">
          {tabs.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-current={tab === item.id ? 'page' : undefined}
              onClick={() => setTab(item.id)}
            >
              {item.label}
              {!!item.count && <span className="tech-count">{item.count}</span>}
            </button>
          ))}
        </nav>

        {notice && (
          <p role="status" className="tech-notice" key={notice}>
            {notice}
          </p>
        )}
        {loading ? (
          <div className="appt-list">
            <ListSkeleton label="Cargando tus citas…" count={3} variant="appointment" />
          </div>
        ) : error ? (
          <p role="alert">
            {error}{' '}
            <BusyButton type="button" className="btn btn-ghost btn-small" onClick={() => load()}>
              Reintentar
            </BusyButton>
          </p>
        ) : !list.length ? (
          <p className="tech-empty">{empty[tab]}</p>
        ) : (
          <div className="appt-list">
            {list.map((a) => (
              <AppointmentCard
                key={a.id}
                status={a.status}
                startsAt={a.startsAt}
                timeZone={a.timeZone}
                client={a.contactName || 'Cliente'}
                request={a.request}
                technician={tab === 'pending' ? undefined : a.assignedTechnician?.name}
                highlight={
                  a === nextVisit
                    ? 'Próxima visita'
                    : active(a) && new Date(a.endsAt).getTime() < now
                      ? 'Sin completar'
                      : undefined
                }
                details={
                  <div>
                    <dt>Ubicación</dt>
                    <dd>
                      {a.locationArea ||
                        a.address ||
                        (a.locationReceivedAt ? 'Recibida' : 'Pendiente')}
                    </dd>
                  </div>
                }
              >
                {tab === 'pending' && (
                  <BusyButton
                    type="button"
                    className="btn btn-primary"
                    busy={busyId === a.id}
                    busyLabel="Confirmando…"
                    onClick={() => void confirm(a.id)}
                  >
                    Confirmar cita
                  </BusyButton>
                )}
                <button type="button" className="btn btn-secondary" onClick={() => setOpenId(a.id)}>
                  Ver cita
                </button>
              </AppointmentCard>
            ))}
          </div>
        )}
      </div>

      {openId && (
        <AppointmentSheet
          id={openId}
          catalog={catalog}
          onClose={() => setOpenId(null)}
          onChanged={(message) => {
            if (message) setNotice(message);
            void load();
          }}
        />
      )}
    </section>
  );
}
