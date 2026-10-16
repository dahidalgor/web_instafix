import {
  appointmentLabels,
  appointmentStatuses,
  type Appointment,
  type Offering,
} from '@instafix/contracts';
import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../../lib/api';
type AdminAppointment = Appointment & {
  offeringId?: string | null;
  user: { name: string; phone: string } | null;
  calUid?: string;
  whatsappConsentAt?: string;
  automationIssue?: string;
  locationLatitude?: number;
  locationLongitude?: number;
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
export function AdminAppointments({ services }: { services: Offering[] }) {
  const [assignedService, setAssignedService] = useState('');
  const [items, setItems] = useState<AdminAppointment[]>([]);
  const [users, setUsers] = useState<{ id: string; name: string; phone: string }[]>([]);
  const [draft, setDraft] = useState({ ...empty });
  const [id, setId] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  async function load() {
    const [next, customers] = await Promise.all([
      api<AdminAppointment[]>('admin/appointments'),
      api('admin/users'),
    ]);
    setItems(next);
    setUsers(customers.filter((u: { role: string }) => u.role === 'CUSTOMER'));
  }
  useEffect(() => {
    load().catch((e) => setMessage(e.message));
  }, []);
  function edit(item: AdminAppointment) {
    setId(item.id);
    setAssignedService(item.offeringId || '');
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
      setMessage('Cita guardada.');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'No se pudo guardar');
    } finally {
      setBusy(false);
    }
  }
  async function assignService() {
    if (!id || !assignedService) return;
    setBusy(true);
    setMessage('');
    try {
      const result = await api(`admin/appointments/${id}/service`, {
        method: 'PATCH',
        body: JSON.stringify({ offeringId: assignedService }),
      });
      setDraft((previous) => ({ ...previous, device: result.device }));
      await load();
      setMessage('Servicio asignado. La descripción y el horario del cliente se conservan.');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'No se pudo asignar');
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
        Las reservas de Cal.com se sincronizan automáticamente al activar la integración. Reprograma
        o cancela esas reservas en Cal.com.
      </p>
      {message && <p role="status">{message}</p>}
      <div className="admin-layout">
        <div>
          <button
            onClick={() => {
              setId(null);
              setDraft({ ...empty });
            }}
          >
            Nueva cita
          </button>
          {items.map((item) => (
            <button className="admin-item" key={item.id} onClick={() => edit(item)}>
              <strong>
                {item.title} · {item.contactName || item.user?.name || 'Invitado'}
              </strong>
              <span>
                {new Date(item.startsAt).toLocaleString('es-EC')} · {appointmentLabels[item.status]}
              </span>
              {item.automationIssue && <span>{item.automationIssue}</span>}
            </button>
          ))}
        </div>
        <form onSubmit={save} className="editor">
          <h3>{id ? 'Editar cita' : 'Nueva cita'}</h3>
          {id && (
            <fieldset>
              <legend>Servicio asignado por el técnico</legend>
              <label>
                Servicio del catálogo
                <select
                  value={assignedService}
                  onChange={(e) => setAssignedService(e.target.value)}
                >
                  <option value="">Pendiente de diagnóstico</option>
                  {services.map((service) => (
                    <option key={service.id} value={service.id}>
                      {service.device} · {service.title}
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" disabled={busy || !assignedService} onClick={assignService}>
                Asignar servicio
              </button>
              <p className="small">
                Al finalizar, registra el trabajo y su garantía en «Trabajos».
              </p>
            </fieldset>
          )}
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
            ['technician', 'Técnico'],
          ].map(([key, label]) => (
            <label key={key}>
              {label}
              <input
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
              disabled={!!items.find((item) => item.id === id)?.calUid}
              required
              type="datetime-local"
              value={draft.startsAt}
              onChange={(e) => setDraft({ ...draft, startsAt: e.target.value })}
            />
          </label>
          <label>
            Fin estimado
            <input
              disabled={!!items.find((item) => item.id === id)?.calUid}
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
              disabled={!!items.find((item) => item.id === id)?.calUid}
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
          {items
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
          <button disabled={busy} className="button">
            {busy ? 'Guardando…' : 'Guardar cita'}
          </button>
        </form>
      </div>
    </section>
  );
}
