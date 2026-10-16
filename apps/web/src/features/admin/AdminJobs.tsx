import type { AccountUser, Appointment, Offering } from '@instafix/contracts';
import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../../lib/api';
import { type RunAction } from './admin.types';
type Props = { users: AccountUser[]; items: Offering[]; run: RunAction; busy: boolean };
export function AdminJobs({ users, items, run, busy }: Props) {
  const [userId, setUserId] = useState('');
  const [serviceId, setServiceId] = useState('');
  const [appointmentId, setAppointmentId] = useState('');
  const [appointments, setAppointments] = useState<(Appointment & { offeringId?: string })[]>([]);
  const [error, setError] = useState('');
  const [price, setPrice] = useState('');
  const load = () =>
    api<(Appointment & { offeringId?: string })[]>('admin/appointments').then(setAppointments);
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, []);
  const choose = (id: string) => {
    setServiceId(id);
    const service = items.find((item) => item.id === id);
    setPrice(service ? (service.priceMinor / 100).toFixed(2) : '');
  };
  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    run(async () => {
      await api('admin/jobs', {
        method: 'POST',
        body: JSON.stringify({
          userId,
          offeringId: serviceId,
          appointmentId: appointmentId || null,
          priceMinor: Math.round(Number(price) * 100),
          warrantyTerms: data.get('warrantyTerms'),
          completedAt: new Date(String(data.get('completedAt'))).toISOString(),
          warrantyEndsAt: data.get('warrantyEndsAt')
            ? new Date(String(data.get('warrantyEndsAt'))).toISOString()
            : null,
        }),
      });
      form.reset();
      setAppointmentId('');
      choose('');
      await load();
    });
  }
  return (
    <form className="editor" onSubmit={handleSubmit}>
      <h2>Registrar trabajo completado</h2>
      <p>
        El técnico selecciona el servicio realizado y confirma precio y garantía. Comprueba la
        identidad del cliente antes de vincular el trabajo a su cuenta.
      </p>
      {error && <p role="alert">{error}</p>}
      <label>
        Cliente
        <select
          required
          value={userId}
          onChange={(e) => {
            setUserId(e.target.value);
            setAppointmentId('');
            choose('');
          }}
        >
          <option value="">Seleccionar cuenta</option>
          {users
            .filter((u) => u.role === 'CUSTOMER')
            .map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} · {u.phone}
              </option>
            ))}
        </select>
      </label>
      <label>
        Cita relacionada (opcional)
        <select
          value={appointmentId}
          onChange={(e) => {
            setAppointmentId(e.target.value);
            choose(appointments.find((a) => a.id === e.target.value)?.offeringId || '');
          }}
        >
          <option value="">Trabajo sin cita registrada</option>
          {appointments
            .filter((a) => a.userId === userId && !['COMPLETED', 'CANCELLED'].includes(a.status))
            .map((a) => (
              <option key={a.id} value={a.id}>
                {new Date(a.startsAt).toLocaleDateString('es-EC')} · {a.title}
              </option>
            ))}
        </select>
      </label>
      <label>
        Servicio realizado
        <select required value={serviceId} onChange={(e) => choose(e.target.value)}>
          <option value="">Seleccionar servicio del catálogo</option>
          {items.map((s) => (
            <option key={s.id} value={s.id}>
              {s.device} · {s.title}
            </option>
          ))}
        </select>
      </label>
      {serviceId && (
        <p className="small">
          Garantía de referencia del catálogo: {items.find((s) => s.id === serviceId)?.warrantyDays}{' '}
          días. Confirma las condiciones aplicables al trabajo.
        </p>
      )}
      <label>
        Precio final USD
        <input
          name="price"
          type="number"
          required
          min="0"
          max="100000"
          step="0.01"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
        />
      </label>
      <label>
        Fecha de finalización
        <input name="completedAt" type="datetime-local" required />
      </label>
      <label>
        Vencimiento de garantía (opcional)
        <input name="warrantyEndsAt" type="datetime-local" />
      </label>
      <label>
        Condiciones de garantía de este trabajo
        <textarea name="warrantyTerms" required maxLength={5000} />
      </label>
      <button className="button" disabled={busy}>
        Registrar trabajo
      </button>
    </form>
  );
}
