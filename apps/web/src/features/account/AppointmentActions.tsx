import type { Appointment } from '@instafix/contracts';
import { useCallback, useState } from 'react';
import { api } from '../../lib/api';
import { dayKey, formatDay, formatTime } from '../booking/booking-time';
import { ScheduleStep, type BookingSlot, type FetchAvailability } from '../booking/ScheduleStep';

/** Reprogramar y cancelar pasan por Instafix: Cal.com solo cambia la agenda. */
export function AppointmentActions({
  appointment,
  onChanged,
}: {
  appointment: Appointment & { calUid?: string | null };
  onChanged: () => void;
}) {
  const [mode, setMode] = useState<null | 'reschedule' | 'cancel'>(null);
  const [slot, setSlot] = useState<BookingSlot | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const fetchAvailability = useCallback<FetchAvailability>(async (start, end) => {
    const data = await api<{ days: Record<string, string[]> }>(
      `booking/slots?from=${start}&to=${end}`,
    );
    return Object.fromEntries(
      Object.entries(data.days).map(([key, starts]) => [key, starts.map((s) => ({ start: s }))]),
    );
  }, []);
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
          <button type="button" className="btn btn-secondary" onClick={() => setMode('reschedule')}>
            Reprogramar
          </button>
          <button type="button" className="btn btn-danger" onClick={() => setMode('cancel')}>
            Cancelar cita
          </button>
        </>
      )}
      {mode === 'reschedule' && (
        <div className="security-panel">
          <ScheduleStep
            fetchAvailability={fetchAvailability}
            selectedDay={day}
            selectedSlot={slot}
            onDayChange={setDay}
            onSlotChange={setSlot}
          />
          {slot && (
            <p>
              Nueva visita: <strong>{formatDay(dayKey(slot.start))}</strong> ·{' '}
              <strong>{formatTime(slot.start)}</strong>
            </p>
          )}
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !slot}
            onClick={() =>
              run(`my/appointments/${appointment.id}/reschedule`, { start: slot?.start })
            }
          >
            {busy ? 'Reprogramando…' : 'Confirmar nuevo horario'}
          </button>{' '}
          <button type="button" className="btn btn-ghost" onClick={() => setMode(null)}>
            Volver
          </button>
        </div>
      )}
      {mode === 'cancel' && (
        <div className="security-panel">
          <p>¿Seguro que quieres cancelar esta cita? El horario quedará libre.</p>
          <button
            type="button"
            className="btn btn-danger"
            disabled={busy}
            onClick={() => run(`my/appointments/${appointment.id}/cancel`)}
          >
            {busy ? 'Cancelando…' : 'Sí, cancelar'}
          </button>{' '}
          <button type="button" className="btn btn-ghost" onClick={() => setMode(null)}>
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
