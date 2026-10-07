import { appointmentLabels, appointmentStatuses, type Appointment } from '@instafix/contracts';
import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../../lib/api';
type AdminAppointment = Appointment & { user: { name: string; phone: string } };
const empty = {
  userId: '',
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
export function AdminAppointments() {
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
    setDraft({
      userId: item.userId,
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
          startsAt: new Date(draft.startsAt).toISOString(),
          endsAt: new Date(draft.endsAt).toISOString(),
        }),
      });
      await load();
      setId(null);
      setDraft({ ...empty });
      setMessage('Cita guardada y visible en la cuenta del cliente.');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'No se pudo guardar');
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
        Esta agenda es de Instafix. Los cambios no se envían todavía a Cal.com ni por WhatsApp.
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
                {item.title} · {item.user.name}
              </strong>
              <span>
                {new Date(item.startsAt).toLocaleString('es-EC')} · {appointmentLabels[item.status]}
              </span>
            </button>
          ))}
        </div>
        <form onSubmit={save} className="editor">
          <h3>{id ? 'Editar cita' : 'Nueva cita'}</h3>
          <label>
            Cliente
            <select
              required
              disabled={!!id}
              value={draft.userId}
              onChange={(e) => setDraft({ ...draft, userId: e.target.value })}
            >
              <option value="">Selecciona una cuenta</option>
              {users.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name} · {user.phone}
                </option>
              ))}
            </select>
          </label>
          {[
            ['title', 'Servicio'],
            ['device', 'Equipo'],
            ['address', 'Dirección'],
            ['technician', 'Técnico'],
          ].map(([key, label]) => (
            <label key={key}>
              {label}
              <input
                required={key === 'title' || key === 'device'}
                maxLength={key === 'address' ? 500 : 100}
                value={draft[key as keyof typeof draft]}
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
              required
              type="datetime-local"
              value={draft.startsAt}
              onChange={(e) => setDraft({ ...draft, startsAt: e.target.value })}
            />
          </label>
          <label>
            Fin estimado
            <input
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
          <button disabled={busy} className="button">
            {busy ? 'Guardando…' : 'Guardar cita'}
          </button>
        </form>
      </div>
    </section>
  );
}
