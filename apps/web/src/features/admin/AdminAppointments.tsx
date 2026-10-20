import {
  appointmentLabels,
  appointmentSorts,
  appointmentStatuses,
  type AppointmentSort,
  type Appointment,
  type Offering,
  type PerformedService,
} from '@instafix/contracts';
import { AppointmentCard } from '../../components/appointments/AppointmentCard';
import { money } from '../../lib/format';
import {
  dateFilters,
  filterAppointments,
  matchesStatus,
  statusFilters,
  type DateFilter,
  type StatusFilter,
} from './appointment-filters';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Disclosure } from '../../components/ui/Disclosure';
import { ListSkeleton } from '../../components/ui/Skeleton';
import { api } from '../../lib/api';
type AdminAppointment = Appointment & {
  offeringId?: string | null;
  user: { name: string; phone: string } | null;
  calUid?: string;
  whatsappConsentAt?: string;
  automationIssue?: string;
  locationLatitude?: number;
  locationLongitude?: number;
  assignedTechnician?: { id: string; name: string; active?: boolean } | null;
  services: PerformedService[];
  technicianNotes?: string;
};
const empty = {
  userId: '',
  contactName: '',
  contactPhone: '',
  whatsappConsent: false,
  title: '',
  device: '',
  startsAt: '',
  endsAt: '',
  address: '',
  technician: '',
  status: 'PENDING_LOCATION',
  timeZone: 'America/Guayaquil',
};
const localDate = (value: string) => {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
export function AdminAppointments(_props: { services: Offering[] }) {
  const [linkUserId, setLinkUserId] = useState('');
  const [identityVerified, setIdentityVerified] = useState(false);
  const [recoverable, setRecoverable] = useState(0);
  // null mientras carga: una lista vacía es un resultado real, no una carga en curso.
  const [items, setItems] = useState<AdminAppointment[] | null>(null);
  const [loadError, setLoadError] = useState('');
  // «auto» conserva el orden por estado de siempre; el resto lo resuelve el backend.
  const [sort, setSort] = useState<'auto' | AppointmentSort>('auto');
  const [formOpen, setFormOpen] = useState(false);
  const organizer = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  // Organizador: por defecto solo citas activas, para que las canceladas no estorben.
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('active');
  const [dateFilter, setDateFilter] = useState<DateFilter>('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [query, setQuery] = useState('');
  const [users, setUsers] = useState<{ id: string; name: string; phone: string }[]>([]);
  const [draft, setDraft] = useState({ ...empty });
  const [id, setId] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  async function load(order = sort) {
    const [next, customers] = await Promise.all([
      api<AdminAppointment[]>(
        order === 'auto' ? 'admin/appointments' : `admin/appointments?sort=${order}`,
      ),
      api('admin/users'),
    ]);
    setItems(next);
    setLoadError('');
    const links = await api<{ recoverable: number }>('admin/booking-links');
    setRecoverable(links.recoverable);
    setUsers(customers.filter((u: { role: string }) => u.role === 'CUSTOMER'));
  }
  useEffect(() => {
    load(sort).catch((e) => setLoadError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sort]);
  function edit(item: AdminAppointment) {
    setFormOpen(true);
    // El formulario está arriba del listado: se lleva a la vista al abrirlo para editar.
    requestAnimationFrame(() =>
      editorRef.current?.scrollIntoView({
        block: 'start',
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      }),
    );
    setId(item.id);
    setLinkUserId('');
    setIdentityVerified(false);
    setDraft({
      userId: item.userId || '',
      contactName: item.contactName || item.user?.name || '',
      contactPhone: item.contactPhone || item.user?.phone || '',
      whatsappConsent: !!item.whatsappConsentAt,
      title: item.title,
      device: item.device,
      startsAt: localDate(item.startsAt),
      endsAt: localDate(item.endsAt),
      timeZone: item.timeZone,
      address: item.address,
      technician: item.technician,
      status: item.status,
    });
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      await api(id ? `admin/appointments/${id}` : 'admin/appointments', {
        method: id ? 'PATCH' : 'POST',
        body: JSON.stringify({
          ...draft,
          userId: draft.userId || null,
          startsAt: new Date(draft.startsAt).toISOString(),
          endsAt: new Date(draft.endsAt).toISOString(),
        }),
      });
      await load();
      setId(null);
      setDraft({ ...empty });
      setFormOpen(false);
      setMessage('Cita guardada.');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'No se pudo guardar');
    } finally {
      setBusy(false);
    }
  }
  const list = items ?? [];
  async function recoverLinks() {
    setBusy(true);
    setMessage('');
    try {
      const result = await api<{ recovered: number }>('admin/booking-links/recover', {
        method: 'POST',
      });
      await load();
      setMessage(`Vínculos recuperados: ${result.recovered}.`);
      setId(null);
      setDraft({ ...empty });
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'No se pudo recuperar');
    } finally {
      setBusy(false);
    }
  }
  async function onTheWay() {
    if (!id) return;
    setBusy(true);
    setMessage('');
    try {
      await api(`admin/appointments/${id}/on-the-way`, { method: 'POST' });
      setMessage('Aviso «técnico en camino» encolado para WhatsApp.');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'No se pudo enviar el aviso');
    } finally {
      setBusy(false);
    }
  }
  async function linkAccount() {
    if (!id || !linkUserId || !identityVerified) return;
    setBusy(true);
    setMessage('');
    try {
      const result = await api<AdminAppointment>(`admin/booking-links/${id}`, {
        method: 'POST',
        body: JSON.stringify({ userId: linkUserId, identityVerified }),
      });
      await load();
      edit(result);
      setMessage('Cita vinculada a la cuenta verificada.');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'No se pudo vincular');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section>
      <h2>Citas de clientes</h2>
      <p>
        Registra o actualiza una cita acordada. Comprueba la identidad antes de vincularla a una
        cuenta.
      </p>
      <p className="small">
        Las reservas se crean en Cal.com desde la web de Instafix. Si reprogramas o cancelas una
        reserva en el panel de Cal.com, el webhook actualiza la cita e Instafix avisa al cliente.
      </p>
      {recoverable > 0 && (
        <p>
          {recoverable} citas tienen una referencia de cuenta comprobable.{' '}
          <button
            type="button"
            className="btn btn-secondary btn-small"
            disabled={busy}
            onClick={recoverLinks}
          >
            Recuperar vínculos
          </button>
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <Disclosure
        open={formOpen}
        onToggle={(next) => {
          setFormOpen(next);
          // Cerrar descarta la edición en curso; el formulario vuelve a «Nueva cita».
          if (!next) {
            setId(null);
            setDraft({ ...empty });
          }
        }}
        title="Nueva cita"
        openTitle={
          id
            ? `Editar cita · ${(() => {
                const item = list.find((x) => x.id === id);
                return item?.contactName || item?.user?.name || 'Invitado';
              })()}`
            : 'Nueva cita'
        }
        className="appt-editor"
      >
        <div ref={editorRef} className="appt-editor-anchor" />
        <form onSubmit={save} className="editor">
          {id && !draft.userId && (
            <fieldset>
              <legend>Vincular cita existente a una cuenta</legend>
              <label>
                Cuenta del cliente
                <select
                  value={linkUserId}
                  onChange={(e) => {
                    setLinkUserId(e.target.value);
                    setIdentityVerified(false);
                  }}
                >
                  <option value="">Selecciona la cuenta verificada</option>
                  {users.map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.name} · {user.phone}
                    </option>
                  ))}
                </select>
              </label>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={identityVerified}
                  onChange={(e) => setIdentityVerified(e.target.checked)}
                />
                He comprobado que esta cita pertenece a este cliente.
              </label>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy || !linkUserId || !identityVerified}
                onClick={linkAccount}
              >
                Vincular a Mi cuenta
              </button>
            </fieldset>
          )}
          {id &&
            list
              .filter((item) => item.id === id)
              .map((item) => (
                <fieldset key={item.id}>
                  <legend>Visita técnica</legend>
                  <p>
                    <strong>Técnico asignado:</strong>{' '}
                    {item.assignedTechnician?.name ||
                      'Sin asignar (lo asigna el técnico al confirmar)'}
                  </p>
                  <p>
                    <strong>Servicios realizados:</strong>{' '}
                    {item.services?.length ? '' : 'Aún sin registrar.'}
                  </p>
                  {!!item.services?.length && (
                    <ul className="performed-list">
                      {item.services.map((s) => (
                        <li key={s.id}>
                          {s.nameSnapshot} ×{s.quantity} · {money(s.totalMinor)}
                        </li>
                      ))}
                    </ul>
                  )}
                  {item.technicianNotes && (
                    <p className="small">
                      <strong>Notas internas:</strong> {item.technicianNotes}
                    </p>
                  )}
                </fieldset>
              ))}
          <label>
            Cliente
            <select
              disabled={!!id}
              value={draft.userId}
              onChange={(e) => {
                const user = users.find((u) => u.id === e.target.value);
                setDraft({
                  ...draft,
                  userId: e.target.value,
                  contactName: user?.name || '',
                  contactPhone: user?.phone || '',
                });
              }}
            >
              <option value="">Invitado sin cuenta</option>
              {users.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name} · {user.phone}
                </option>
              ))}
            </select>
          </label>
          {[
            ['contactName', 'Nombre del cliente'],
            ['contactPhone', 'WhatsApp con código de país'],
            ['title', 'Descripción del cliente'],
            ['device', 'Equipo'],
            ['address', 'Dirección'],
            ['technician', 'Técnico (texto, citas manuales)'],
          ].map(([key, label]) => (
            <label key={key}>
              {label}
              <input
                disabled={
                  key === 'technician' && !!list.find((item) => item.id === id)?.assignedTechnician
                }
                required={key === 'title' || key === 'device'}
                maxLength={key === 'address' ? 500 : 100}
                value={String(draft[key as keyof typeof draft])}
                onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
              />
            </label>
          ))}
          <p className="small">
            Introduce las fechas en la hora local de tu navegador (
            {Intl.DateTimeFormat().resolvedOptions().timeZone}).
          </p>
          <label>
            Inicio
            <input
              disabled={!!list.find((item) => item.id === id)?.calUid}
              required
              type="datetime-local"
              value={draft.startsAt}
              onChange={(e) => setDraft({ ...draft, startsAt: e.target.value })}
            />
          </label>
          <label>
            Fin estimado
            <input
              disabled={!!list.find((item) => item.id === id)?.calUid}
              required
              type="datetime-local"
              value={draft.endsAt}
              onChange={(e) => setDraft({ ...draft, endsAt: e.target.value })}
            />
          </label>
          <label>
            Zona horaria para el cliente
            <select
              value={draft.timeZone}
              onChange={(e) => setDraft({ ...draft, timeZone: e.target.value })}
            >
              <option>America/Guayaquil</option>
              <option>Pacific/Galapagos</option>
              <option>UTC</option>
            </select>
          </label>
          <label>
            Estado
            <select
              disabled={!!list.find((item) => item.id === id)?.calUid}
              value={draft.status}
              onChange={(e) => setDraft({ ...draft, status: e.target.value })}
            >
              {appointmentStatuses.map((status) => (
                <option key={status} value={status}>
                  {appointmentLabels[status]}
                </option>
              ))}
            </select>
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={draft.whatsappConsent}
              onChange={(e) => setDraft({ ...draft, whatsappConsent: e.target.checked })}
            />
            El cliente autorizó recibir mensajes de esta cita por WhatsApp.
          </label>
          {list
            .filter(
              (item) =>
                item.id === id && item.locationLatitude != null && item.locationLongitude != null,
            )
            .map((item) => (
              <a
                key={item.id}
                href={`https://www.google.com/maps?q=${item.locationLatitude},${item.locationLongitude}`}
                target="_blank"
                rel="noreferrer"
              >
                Ver ubicación del cliente
              </a>
            ))}
          {id && ['CONFIRMED', 'IN_PROGRESS'].includes(draft.status) && (
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={onTheWay}>
              Avisar «técnico en camino» por WhatsApp
            </button>
          )}
          <button disabled={busy} className="button">
            {busy ? 'Guardando…' : 'Guardar cita'}
          </button>
        </form>
      </Disclosure>
      <div className="appt-organizer" ref={organizer}>
        <div className="appt-filters" role="search" aria-label="Filtrar citas">
          <div className="filters" role="group" aria-label="Estado">
            {statusFilters.map((option) => (
              <button
                key={option.id}
                type="button"
                aria-pressed={statusFilter === option.id}
                className={statusFilter === option.id ? 'active' : ''}
                onClick={() => setStatusFilter(option.id)}
              >
                {option.label}{' '}
                <span className="filter-count">
                  {list.filter((item) => matchesStatus(item, option.id)).length}
                </span>
              </button>
            ))}
          </div>
          <div className="appt-filter-row">
            <label>
              Fecha
              <select
                value={dateFilter}
                onChange={(e) => setDateFilter(e.target.value as DateFilter)}
              >
                {dateFilters.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            {dateFilter === 'custom' && (
              <>
                <label>
                  Desde
                  <input
                    type="date"
                    value={from}
                    max={to || undefined}
                    onChange={(e) => setFrom(e.target.value)}
                  />
                </label>
                <label>
                  Hasta
                  <input
                    type="date"
                    value={to}
                    min={from || undefined}
                    onChange={(e) => setTo(e.target.value)}
                  />
                </label>
              </>
            )}
            <label>
              Ordenar
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as 'auto' | AppointmentSort)}
              >
                <option value="auto">Según el estado (recomendado)</option>
                {appointmentSorts.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="appt-filter-search">
              Buscar
              <input
                type="search"
                placeholder="Nombre, teléfono o solicitud"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
          </div>
        </div>
        {items === null && loadError && (
          <div className="admin-message" role="alert">
            {loadError}{' '}
            <button
              type="button"
              className="btn btn-secondary btn-small"
              onClick={() => load().catch((e) => setLoadError(e.message))}
            >
              Reintentar
            </button>
          </div>
        )}
        {items === null && !loadError && (
          <div className="appt-list admin-appt-list">
            <ListSkeleton label="Cargando citas…" count={4} variant="appointment" />
          </div>
        )}
        {items !== null &&
          (() => {
            const shown = filterAppointments(list, {
              status: statusFilter,
              date: dateFilter,
              from,
              to,
              query,
              // Con un orden elegido se respeta el del backend; si no, el automático por estado.
              keepOrder: sort !== 'auto',
            });
            return (
              <>
                <p className="small" role="status">
                  {shown.length === 1 ? '1 cita' : `${shown.length} citas`}
                  {(statusFilter !== 'all' || dateFilter !== 'all' || query) &&
                    shown.length !== list.length && (
                      <>
                        {' '}
                        de {list.length} ·{' '}
                        <button
                          type="button"
                          className="btn btn-ghost btn-small"
                          onClick={() => {
                            setStatusFilter('all');
                            setDateFilter('all');
                            setQuery('');
                          }}
                        >
                          Ver todas
                        </button>
                      </>
                    )}
                </p>
                {!shown.length && <p className="tech-empty">No hay citas con estos filtros.</p>}
                <div className="appt-list admin-appt-list">
                  {shown.map((item) => (
                    <AppointmentCard
                      key={item.id}
                      status={item.status}
                      startsAt={item.startsAt}
                      timeZone={item.timeZone}
                      client={item.contactName || item.user?.name || 'Invitado'}
                      request={item.title}
                      technician={
                        item.assignedTechnician
                          ? item.assignedTechnician.name +
                            (item.assignedTechnician.active === false
                              ? ' (técnico desactivado)'
                              : '')
                          : item.technician || null
                      }
                      highlight={item.id === id ? 'Editando' : undefined}
                      details={
                        <>
                          {!!item.services?.length && (
                            <div>
                              <dt>Servicios realizados</dt>
                              <dd>
                                {item.services
                                  .map(
                                    (s) =>
                                      s.nameSnapshot + (s.quantity > 1 ? ` ×${s.quantity}` : ''),
                                  )
                                  .join(', ')}
                              </dd>
                            </div>
                          )}
                          {item.automationIssue && (
                            <div>
                              <dt>Incidencia</dt>
                              <dd>{item.automationIssue}</dd>
                            </div>
                          )}
                        </>
                      }
                    >
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() => edit(item)}
                      >
                        Ver y editar
                      </button>
                    </AppointmentCard>
                  ))}
                </div>
              </>
            );
          })()}
      </div>
    </section>
  );
}
