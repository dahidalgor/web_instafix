import type { Appointment } from '@instafix/contracts';
import { useState } from 'react';
import { api } from '../../lib/api';
import { SlotPicker, slotDate, slotTime } from '../booking/SlotPicker';

/** Reprogramar y cancelar pasan por Instafix: Cal.com solo cambia la agenda. */
export function AppointmentActions({
  appointment,
  onChanged,
}: {
  appointment: Appointment & { calUid?: string | null };
  onChanged: () => void;
}) {
  const [mode, setMode] = useState<null | 'reschedule' | 'cancel'>(null);
  const [slot, setSlot] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const changeable =
    appointment.calUid &&
    ['PENDING_LOCATION', 'CONFIRMED'].includes(appointment.status) &&
    new Date(appointment.startsAt).getTime() > Date.now();
  if (!changeable) return null;
  async function run(path: string, body?: unknown) {
    setBusy(true);
    setError('');
    try {
      await api(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
      setMode(null);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo completar la operación.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="appointment-actions">
      {!mode && (
        <>
          <button type="button" className="text-button" onClick={() => setMode('reschedule')}>
            Reprogramar
          </button>
          <button type="button" className="text-button danger" onClick={() => setMode('cancel')}>
            Cancelar cita
          </button>
        </>
      )}
      {mode === 'reschedule' && (
        <div className="security-panel">
          <SlotPicker selected={slot} onSelect={setSlot} />
          {slot && (
            <p>
              Nueva visita: <strong>{slotDate(slot)}</strong> · <strong>{slotTime(slot)}</strong>
            </p>
          )}
          <button
            type="button"
            className="button"
            disabled={busy || !slot}
            onClick={() => run(`my/appointments/${appointment.id}/reschedule`, { start: slot })}
          >
            {busy ? 'Reprogramando…' : 'Confirmar nuevo horario'}
          </button>{' '}
          <button type="button" className="text-button" onClick={() => setMode(null)}>
            Volver
          </button>
        </div>
      )}
      {mode === 'cancel' && (
        <div className="security-panel">
          <p>¿Seguro que quieres cancelar esta cita? El horario quedará libre.</p>
          <button
            type="button"
            className="button danger"
            disabled={busy}
            onClick={() => run(`my/appointments/${appointment.id}/cancel`)}
          >
            {busy ? 'Cancelando…' : 'Sí, cancelar'}
          </button>{' '}
          <button type="button" className="text-button" onClick={() => setMode(null)}>
            No, mantener
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </div>
  );
}
