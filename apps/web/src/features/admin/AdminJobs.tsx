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
  // Búsqueda de cliente en el servidor (todas las cuentas, por nombre o número).
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<AccountUser[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<AccountUser | null>(null);
  useEffect(() => {
    const q = query.trim();
    const enough = q.replace(/\D/g, '').length >= 3 || q.replace(/[\d\s+()-]/g, '').length >= 2;
    if (!enough) {
      setResults([]);
      return;
    }
    const controller = new AbortController();
    setSearching(true);
    const timer = window.setTimeout(() => {
      api<AccountUser[]>(`admin/users?role=CUSTOMER&q=${encodeURIComponent(q)}`, {
        signal: controller.signal,
      })
        .then(setResults)
        .catch((e) => {
          if (!controller.signal.aborted) setError(e.message);
        })
        .finally(() => !controller.signal.aborted && setSearching(false));
    }, 250);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query]);
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
    if (!userId) {
      setError('Busca y selecciona el cliente del trabajo.');
      return;
    }
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
      setUserId('');
      setSelected(null);
      setQuery('');
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
      <div className="customer-search">
        <label htmlFor="job-customer-search">Cliente</label>
        {selected ? (
          <div className="customer-chosen">
            <div>
              <strong>{selected.name}</strong>
              <span>
                {selected.phone}
                {selected.email ? ` · ${selected.email}` : ''}
              </span>
            </div>
            <button
              type="button"
              className="btn btn-ghost btn-small"
              onClick={() => {
                setUserId('');
                setAppointmentId('');
                choose('');
                setQuery('');
              }}
            >
              Cambiar
            </button>
          </div>
        ) : (
          <>
            <input
              id="job-customer-search"
              type="search"
              autoComplete="off"
              placeholder="Escribe nombre o número (ej.: David o 0991234567)"
              value={query}
              aria-describedby="job-customer-help"
              onChange={(e) => setQuery(e.target.value)}
            />
            <p className="small" id="job-customer-help" role="status">
              {searching
                ? 'Buscando…'
                : query.trim().length < 2
                  ? 'Escribe al menos 2 letras o 3 números.'
                  : results.length
                    ? `${results.length} ${results.length === 1 ? 'cliente encontrado' : 'clientes encontrados'}`
                    : 'Sin resultados. Revisa el nombre o el número.'}
            </p>
            {!!results.length && (
              <ul className="customer-results">
                {results.map((u) => (
                  <li key={u.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setUserId(u.id);
                        setSelected(u);
                        setAppointmentId('');
                        choose('');
                      }}
                    >
                      <strong>{u.name}</strong>
                      <span>
                        {u.phone}
                        {u.email ? ` · ${u.email}` : ''}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
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
      <button className="btn btn-primary btn-block" disabled={busy || !userId}>
        Registrar trabajo
      </button>
    </form>
  );
}
