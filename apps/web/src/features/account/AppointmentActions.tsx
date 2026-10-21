import { MAX_RESCHEDULES, type Appointment } from '@instafix/contracts';
import { useCallback, useRef, useState } from 'react';
import { BusyLabel } from '../../components/ui/BusyLabel';
import { api, newIdempotencyKey } from '../../lib/api';
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
  // Una clave por intento: un reintento (doble clic, red caída) no repite la acción.
  const attempt = useRef<{ action: string; key: string } | null>(null);
  const limitReached = (appointment.rescheduleCount ?? 0) >= MAX_RESCHEDULES;
  const changeable =
    appointment.calUid &&
    ['PENDING_LOCATION', 'CONFIRMED'].includes(appointment.status) &&
    new Date(appointment.startsAt).getTime() > Date.now();
  if (!changeable) return null;
  async function run(path: string, body?: unknown) {
    setBusy(true);
    setError('');
    try {
      const action = `${path}:${JSON.stringify(body ?? null)}`;
      if (attempt.current?.action !== action)
        attempt.current = { action, key: newIdempotencyKey() };
      await api(path, {
        method: 'POST',
        body: body ? JSON.stringify(body) : undefined,
        headers: { 'Idempotency-Key': attempt.current.key },
      });
      attempt.current = null;
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
          {limitReached ? (
            <p className="appt-hint">
              Esta cita alcanzó el límite de reagendamientos. Si necesitas otro horario, cancela la
              cita y solicita una nueva.
            </p>
          ) : (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setMode('reschedule')}
            >
              Reprogramar
            </button>
          )}
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
          <div className="confirm-actions">
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy}
              onClick={() => setMode(null)}
            >
              Volver
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !slot}
              aria-busy={busy}
              onClick={() =>
                run(`my/appointments/${appointment.id}/reschedule`, { start: slot?.start })
              }
            >
              <BusyLabel busy={busy} label="Confirmar horario" busyLabel="Reprogramando…" />
            </button>
          </div>
        </div>
      )}
      {mode === 'cancel' && (
        <div className="security-panel">
          <p>¿Seguro que quieres cancelar esta cita? El horario quedará libre.</p>
          {/* Dos columnas fijas: el estado de carga no cambia tamaño ni posición de los botones. */}
          <div className="confirm-actions">
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy}
              onClick={() => setMode(null)}
            >
              Mantener cita
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy}
              aria-busy={busy}
              onClick={() => run(`my/appointments/${appointment.id}/cancel`)}
            >
              <BusyLabel busy={busy} label="Sí, cancelar" busyLabel="Cancelando…" />
            </button>
          </div>
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
