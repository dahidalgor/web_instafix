import type { RepairOrderView } from '@instafix/contracts';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { RepairCard } from '../../components/repairs/RepairCard';
import { BusyButton } from '../../components/ui/BusyButton';
import { api, ApiError } from '../../lib/api';

/**
 * Equipos que el técnico se lleva al taller desde esta visita (además de lo que hizo en ella):
 * cada uno abre un trabajo de taller con su código, que el cliente ve en Mi cuenta → En taller.
 */
export function VisitRepairs({
  appointmentId,
  canAdd,
}: {
  appointmentId: string;
  canAdd: boolean;
}) {
  const [orders, setOrders] = useState<RepairOrderView[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [form, setForm] = useState({ device: '', reportedFault: '', intakeCondition: '' });

  const load = useCallback(
    () =>
      api<RepairOrderView[]>(`staff/appointments/${appointmentId}/repairs`)
        .then(setOrders)
        .catch(() => setOrders([])),
    [appointmentId],
  );
  useEffect(() => {
    void load();
  }, [load]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      const created = await api<RepairOrderView>(`staff/appointments/${appointmentId}/repairs`, {
        method: 'POST',
        body: JSON.stringify(form),
      });
      setMessage(`✓ ${created.code}: ${created.device} registrado en el taller.`);
      setForm({ device: '', reportedFault: '', intakeCondition: '' });
      setAdding(false);
      await load();
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : 'No se pudo registrar el equipo.');
    } finally {
      setBusy(false);
    }
  }

  if (!orders?.length && !canAdd) return null;
  return (
    <div className="tech-block">
      <h3>Equipos al taller</h3>
      {message && (
        <p className="small" role="status">
          {message}
        </p>
      )}
      {!!orders?.length && (
        <div className="repair-list">
          {orders.map((o) => (
            <RepairCard key={o.id} order={o} />
          ))}
        </div>
      )}
      {canAdd &&
        (adding ? (
          <form className="repair-form" onSubmit={submit}>
            <label>
              Equipo
              <input
                value={form.device}
                maxLength={80}
                placeholder="Ej.: control DualSense, PS4 Slim"
                onChange={(e) => setForm({ ...form, device: e.target.value })}
              />
            </label>
            <label>
              Falla que indica el cliente
              <input
                value={form.reportedFault}
                maxLength={300}
                placeholder="Ej.: drift en el joystick izquierdo"
                onChange={(e) => setForm({ ...form, reportedFault: e.target.value })}
              />
            </label>
            <label>
              Cómo lo recibes (estado y accesorios)
              <textarea
                value={form.intakeCondition}
                maxLength={500}
                placeholder="Ej.: sin cable, rayón en la tapa, enciende"
                onChange={(e) => setForm({ ...form, intakeCondition: e.target.value })}
              />
            </label>
            <p className="small">
              El cliente lo verá en su cuenta con su número de orden. Lo que cobraste en la visita
              va aparte, en «Servicios realizados».
            </p>
            <div className="tech-actions-row">
              <button type="button" className="btn btn-ghost" onClick={() => setAdding(false)}>
                Cancelar
              </button>
              <BusyButton
                type="submit"
                className="btn btn-primary"
                busy={busy}
                busyLabel="Registrando…"
                disabled={
                  form.device.trim().length < 2 ||
                  form.reportedFault.trim().length < 3 ||
                  form.intakeCondition.trim().length < 3
                }
              >
                Registrar equipo
              </BusyButton>
            </div>
          </form>
        ) : (
          <button type="button" className="btn btn-ghost btn-block" onClick={() => setAdding(true)}>
            + Me llevo un equipo al taller
          </button>
        ))}
    </div>
  );
}
