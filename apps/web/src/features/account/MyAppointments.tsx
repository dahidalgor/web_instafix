import { appointmentLabels, type BookingSlot, type MyAppointment } from '@instafix/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { dayKey, formatDay, formatTime, newRequestKey } from '../booking/booking-time';
import { ScheduleStep, type FetchAvailability } from '../booking/ScheduleStep';

export type MyAppointmentsData = { upcoming: MyAppointment[]; history: MyAppointment[] };

const statusTone: Record<string, string> = {
  CONFIRMED: 'ok',
  PENDING_LOCATION: 'pending',
  CREATING: 'pending',
  IN_PROGRESS: 'ok',
  COMPLETED: 'done',
  CANCELLED: 'off',
  RESCHEDULED: 'off',
  NO_SHOW: 'off',
};

function when(appointment: MyAppointment) {
  return `${formatDay(dayKey(appointment.startsAt), true)} · ${formatTime(appointment.startsAt)}`;
}

export function MyAppointments({
  data,
  onChanged,
}: {
  data: MyAppointmentsData;
  onChanged: () => Promise<void> | void;
}) {
  const [tab, setTab] = useState<'upcoming' | 'history'>('upcoming');
  const [openId, setOpenId] = useState<string | null>(null);
  const list = tab === 'upcoming' ? data.upcoming : data.history;
  const open = [...data.upcoming, ...data.history].find((a) => a.id === openId) ?? null;

  return (
    <>
      <div className="filters" role="tablist" aria-label="Mis citas">
        <button
          role="tab"
          aria-selected={tab === 'upcoming'}
          className={tab === 'upcoming' ? 'active' : ''}
          onClick={() => setTab('upcoming')}
        >
          Próximas ({data.upcoming.length})
        </button>
        <button
          role="tab"
          aria-selected={tab === 'history'}
          className={tab === 'history' ? 'active' : ''}
          onClick={() => setTab('history')}
        >
          Historial ({data.history.length})
        </button>
      </div>
      {!list.length && (
        <div className="empty-account">
          <h2>{tab === 'upcoming' ? 'No tienes citas próximas' : 'Tu historial comienza aquí'}</h2>
          <p>
            {tab === 'upcoming'
              ? 'Agenda una visita y aparecerá aquí al instante.'
              : 'Las citas pasadas, canceladas o completadas aparecerán aquí.'}
          </p>
          <a className="button" href="#agenda">
            Agendar una cita ↗
          </a>
        </div>
      )}
      <div className="appointment-list">
        {list.map((item) => (
          <article className="appointment-card" key={item.id}>
            <div className="appointment-card-head">
              <p className="eyebrow">
                {item.status === 'CONFIRMED' || item.status === 'PENDING_LOCATION'
                  ? 'VISITA PROGRAMADA'
                  : 'VISITA'}
              </p>
              <span className={`status-pill tone-${statusTone[item.status] ?? 'pending'}`}>
                {appointmentLabels[item.status]}
                {item.status === 'CONFIRMED' && ' ✓'}
              </span>
            </div>
            <h2>{when(item)}</h2>
            <p className="appointment-request">“{item.customerRequest}”</p>
            {item.needsReview && (
              <p role="status" className="calendar-account-note">
                Tu reserva está en revisión porque sus datos de contacto no coinciden con tu cuenta.
                Escríbenos para corregirlos.
              </p>
            )}
            <button className="text-button" onClick={() => setOpenId(item.id)}>
              Ver detalles
            </button>
          </article>
        ))}
      </div>
      {open && (
        <AppointmentDialog
          appointment={open}
          onClose={() => setOpenId(null)}
          onChanged={async (next) => {
            await onChanged();
            setOpenId(next?.id ?? null);
            if (next) setTab('upcoming');
          }}
        />
      )}
    </>
  );
}

function AppointmentDialog({
  appointment,
  onClose,
  onChanged,
}: {
  appointment: MyAppointment;
  onClose: () => void;
  onChanged: (next: MyAppointment | null) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [mode, setMode] = useState<'view' | 'cancel' | 'reschedule'>('view');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [day, setDay] = useState<string | null>(null);
  const [slot, setSlot] = useState<BookingSlot | null>(null);
  const [takenSlot, setTakenSlot] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const key = useRef<string | null>(null);

  useEffect(() => {
    dialog.current?.showModal();
    document.body.classList.add('service-dialog-open');
    return () => document.body.classList.remove('service-dialog-open');
  }, []);

  const fetchAvailability = useCallback<FetchAvailability>(
    async (start, end) => {
      const result = await api<{ days: Record<string, BookingSlot[]> }>(
        `appointments/me/${appointment.id}/availability?start=${start}&end=${end}`,
      ).catch((e: unknown) => {
        throw new Error(e instanceof Error ? e.message : 'No pudimos consultar los horarios.');
      });
      return result.days;
    },
    [appointment.id],
  );

  async function cancel() {
    setBusy(true);
    setError('');
    try {
      await api(`appointments/me/${appointment.id}/cancel`, { method: 'POST', body: '{}' });
      await onChanged(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No pudimos cancelar la cita.');
    } finally {
      setBusy(false);
    }
  }

  async function reschedule() {
    if (!slot) return;
    setBusy(true);
    setError('');
    key.current ??= newRequestKey();
    try {
      const next = await api<MyAppointment>(`appointments/me/${appointment.id}/reschedule`, {
        method: 'POST',
        body: JSON.stringify({ requestKey: key.current, start: slot.start }),
      });
      await onChanged(next);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'SLOT_TAKEN') {
        setTakenSlot(slot.start);
        setSlot(null);
        setRefreshKey((n) => n + 1);
        key.current = null;
      } else {
        if (!(e instanceof ApiError && e.code === 'UNCERTAIN')) key.current = null;
        setError(e instanceof Error ? e.message : 'No pudimos reprogramar la cita.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      className="service-dialog appointment-dialog"
      aria-labelledby="appointment-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <article>
        <button className="dialog-close" aria-label="Cerrar" disabled={busy} onClick={onClose}>
          ×
        </button>
        <p className="eyebrow">{appointmentLabels[appointment.status].toUpperCase()}</p>
        <h2 id="appointment-dialog-title">{when(appointment)}</h2>
        {mode === 'view' && (
          <>
            <dl className="appointment-details">
              <div>
                <dt>Tu solicitud</dt>
                <dd>“{appointment.customerRequest}”</dd>
              </div>
              {appointment.device !== 'Por especificar' && (
                <div>
                  <dt>Equipo</dt>
                  <dd>{appointment.device}</dd>
                </div>
              )}
              <div>
                <dt>Servicio asignado por el técnico</dt>
                <dd>
                  {appointment.assignedService
                    ? `${appointment.assignedService.device} · ${appointment.assignedService.title}`
                    : 'Pendiente de diagnóstico'}
                </dd>
              </div>
              <div>
                <dt>Hora estimada de fin</dt>
                <dd>{formatTime(appointment.endsAt)}</dd>
              </div>
              <div>
                <dt>Técnico</dt>
                <dd>{appointment.technician || 'Por asignar'}</dd>
              </div>
              {appointment.cancellationReason && (
                <div>
                  <dt>Motivo de cancelación</dt>
                  <dd>{appointment.cancellationReason}</dd>
                </div>
              )}
            </dl>
            <p className="small">Referencia: {appointment.id}</p>
            {(appointment.canCancel || appointment.canReschedule) && (
              <div className="appointment-actions">
                {appointment.canReschedule && (
                  <button className="button" onClick={() => setMode('reschedule')}>
                    Reprogramar <span>→</span>
                  </button>
                )}
                {appointment.canCancel && (
                  <button className="text-button danger" onClick={() => setMode('cancel')}>
                    Cancelar cita
                  </button>
                )}
              </div>
            )}
            {!appointment.canCancel &&
              ['CONFIRMED', 'PENDING_LOCATION'].includes(appointment.status) && (
                <p className="small">
                  Faltan menos de 2 horas para tu visita. Para cambios, escríbenos por WhatsApp.
                </p>
              )}
          </>
        )}
        {mode === 'cancel' && (
          <div className="appointment-confirm">
            <p>
              ¿Seguro que quieres cancelar esta visita? El horario quedará libre para otra persona.
            </p>
            <div className="appointment-actions">
              <button className="button danger" disabled={busy} onClick={cancel}>
                {busy ? 'Cancelando…' : 'Sí, cancelar cita'}
              </button>
              <button className="text-button" disabled={busy} onClick={() => setMode('view')}>
                Volver
              </button>
            </div>
          </div>
        )}
        {mode === 'reschedule' && (
          <div className="appointment-reschedule">
            <p className="step-help">Elige un nuevo día y horario. Tu solicitud se mantiene.</p>
            <ScheduleStep
              fetchAvailability={fetchAvailability}
              selectedDay={day}
              selectedSlot={slot}
              onDayChange={setDay}
              onSlotChange={(next) => {
                setSlot(next);
                key.current = null;
                if (next) setTakenSlot(null);
              }}
              takenSlot={takenSlot}
              refreshKey={refreshKey}
            />
            <div className="appointment-actions">
              <button className="button" disabled={busy || !slot} onClick={reschedule}>
                {busy
                  ? 'Reprogramando…'
                  : slot
                    ? `Cambiar a ${formatTime(slot.start)}`
                    : 'Elige un horario'}
              </button>
              <button className="text-button" disabled={busy} onClick={() => setMode('view')}>
                Volver
              </button>
            </div>
          </div>
        )}
        {error && (
          <p role="alert" className="booking-error">
            {error}
          </p>
        )}
      </article>
    </dialog>
  );
}
