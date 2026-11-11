import {
  busyBlockHours,
  weekdayNames,
  type BusyBlock,
  type BusyBlockInput,
} from '@instafix/contracts';
import { useEffect, useState, type FormEvent } from 'react';
import { BusyButton } from '../../components/ui/BusyButton';
import { ListSkeleton } from '../../components/ui/Skeleton';
import { api, ApiError } from '../../lib/api';

/** Lunes primero, como en un horario de clases. */
const weekOrder = [1, 2, 3, 4, 5, 6, 0];
const shortDays = ['D', 'L', 'M', 'X', 'J', 'V', 'S'];
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Guayaquil' }).format();
const longDate = (value: string) =>
  new Intl.DateTimeFormat('es-EC', {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  })
    .format(new Date(`${value}T12:00:00Z`))
    .replace(/\./g, '');

/**
 * Horarios ocupados del técnico (clases, otro trabajo…). En esas horas no le llegan solicitudes
 * ni puede confirmar citas, y la web no ofrece horarios en que ningún técnico esté libre.
 */
export function TechnicianSchedule() {
  const [blocks, setBlocks] = useState<BusyBlock[] | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState({
    label: '',
    repeat: 'WEEKLY' as 'WEEKLY' | 'ONCE',
    weekdays: [] as number[],
    date: '',
    validUntil: '',
    allDay: false,
    start: '08:00',
    end: '12:00',
  });

  useEffect(() => {
    api<{ blocks: BusyBlock[] }>('/staff/busy')
      .then((res) => setBlocks(res.blocks))
      .catch((e) =>
        setError(e instanceof ApiError ? e.message : 'No pudimos cargar tus horarios.'),
      );
  }, []);

  async function add(event: FormEvent) {
    event.preventDefault();
    setBusy('add');
    setError('');
    setMessage('');
    const body: BusyBlockInput = {
      label: form.label,
      repeat: form.repeat,
      allDay: form.allDay,
      ...(form.repeat === 'WEEKLY'
        ? { weekdays: form.weekdays, ...(form.validUntil ? { validUntil: form.validUntil } : {}) }
        : { date: form.date }),
      ...(form.allDay ? {} : { start: form.start, end: form.end }),
    };
    try {
      const res = await api<{ blocks: BusyBlock[]; conflicts: number }>('/staff/busy', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setBlocks(res.blocks);
      setForm({ ...form, label: '', weekdays: [], date: '', validUntil: '' });
      setMessage(
        res.conflicts
          ? `Guardado. Ojo: ya tienes ${res.conflicts === 1 ? 'una visita confirmada' : `${res.conflicts} visitas confirmadas`} en ese horario; esas no cambian, avisa a administración si no puedes ir.`
          : 'Guardado. En ese horario ya no te llegarán solicitudes.',
      );
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'No pudimos guardar el horario.');
    } finally {
      setBusy(null);
    }
  }

  async function remove(id: string) {
    setBusy(id);
    setError('');
    setMessage('');
    try {
      const res = await api<{ blocks: BusyBlock[] }>(`/staff/busy/${id}`, { method: 'DELETE' });
      setBlocks(res.blocks);
      setMessage('Horario quitado.');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'No pudimos quitar el horario.');
    } finally {
      setBusy(null);
    }
  }

  const toggleDay = (day: number) =>
    setForm({
      ...form,
      weekdays: form.weekdays.includes(day)
        ? form.weekdays.filter((d) => d !== day)
        : [...form.weekdays, day],
    });
  const weekly = (blocks ?? [])
    .filter((b) => b.weekday !== null)
    .sort(
      (a, b) =>
        weekOrder.indexOf(a.weekday!) - weekOrder.indexOf(b.weekday!) ||
        a.startMinute - b.startMinute,
    );
  const once = (blocks ?? []).filter((b) => b.date);

  const row = (block: BusyBlock, when: string) => (
    <li key={block.id} className="busy-row">
      <div>
        <strong>{when}</strong>
        <span>
          {busyBlockHours(block)} · {block.label}
          {block.validUntil ? ` · hasta el ${longDate(block.validUntil)}` : ''}
        </span>
      </div>
      <BusyButton
        type="button"
        className="btn btn-ghost btn-small"
        disabled={busy !== null}
        busy={busy === block.id}
        busyLabel="Quitando…"
        onClick={() => void remove(block.id)}
      >
        Quitar
      </BusyButton>
    </li>
  );

  return (
    <div className="settings-stack">
      <section className="settings-card" aria-labelledby="busy-title">
        <div className="settings-card-head">
          <h2 id="busy-title">Mis horarios ocupados</h2>
          <p>
            En esas horas no te llegan solicitudes ni puedes confirmar citas. Las visitas que ya
            confirmaste no cambian.
          </p>
        </div>
        {!blocks && error ? (
          <p role="alert">{error}</p>
        ) : !blocks ? (
          <ListSkeleton label="Cargando tus horarios…" count={2} />
        ) : (
          <>
            {!weekly.length && !once.length && (
              <p className="tech-empty">Aún no marcaste ningún horario: estás libre siempre.</p>
            )}
            {!!weekly.length && (
              <>
                <h3 className="busy-heading">Cada semana</h3>
                <ul className="busy-list">{weekly.map((b) => row(b, weekdayNames[b.weekday!]))}</ul>
              </>
            )}
            {!!once.length && (
              <>
                <h3 className="busy-heading">Días concretos</h3>
                <ul className="busy-list">{once.map((b) => row(b, longDate(b.date!)))}</ul>
              </>
            )}
          </>
        )}
      </section>

      <section className="settings-card" aria-labelledby="busy-add">
        <div className="settings-card-head">
          <h2 id="busy-add">Agregar horario ocupado</h2>
        </div>
        <form className="busy-form" onSubmit={add}>
          <label>
            Motivo
            <input
              required
              minLength={2}
              maxLength={60}
              placeholder="Clases, otro trabajo…"
              value={form.label}
              onChange={(e) => setForm({ ...form, label: e.target.value })}
            />
          </label>
          <fieldset className="busy-repeat">
            <legend>Se repite</legend>
            <label className="checkbox-label">
              <input
                type="radio"
                name="repeat"
                checked={form.repeat === 'WEEKLY'}
                onChange={() => setForm({ ...form, repeat: 'WEEKLY' })}
              />
              Cada semana
            </label>
            <label className="checkbox-label">
              <input
                type="radio"
                name="repeat"
                checked={form.repeat === 'ONCE'}
                onChange={() => setForm({ ...form, repeat: 'ONCE' })}
              />
              Solo un día
            </label>
          </fieldset>
          {form.repeat === 'WEEKLY' ? (
            <>
              <fieldset>
                <legend>Días</legend>
                <div className="busy-days">
                  {weekOrder.map((day) => (
                    <button
                      key={day}
                      type="button"
                      className={form.weekdays.includes(day) ? 'is-on' : ''}
                      aria-pressed={form.weekdays.includes(day)}
                      aria-label={weekdayNames[day]}
                      onClick={() => toggleDay(day)}
                    >
                      {shortDays[day]}
                    </button>
                  ))}
                </div>
              </fieldset>
              <label>
                Hasta (opcional, p. ej. fin de semestre)
                <input
                  type="date"
                  min={today()}
                  value={form.validUntil}
                  onChange={(e) => setForm({ ...form, validUntil: e.target.value })}
                />
              </label>
            </>
          ) : (
            <label>
              Día
              <input
                type="date"
                required
                min={today()}
                value={form.date}
                onChange={(e) => setForm({ ...form, date: e.target.value })}
              />
            </label>
          )}
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={form.allDay}
              onChange={(e) => setForm({ ...form, allDay: e.target.checked })}
            />
            Todo el día
          </label>
          {!form.allDay && (
            <div className="busy-hours">
              <label>
                Desde
                <input
                  type="time"
                  required
                  value={form.start}
                  onChange={(e) => setForm({ ...form, start: e.target.value })}
                />
              </label>
              <label>
                Hasta
                <input
                  type="time"
                  required
                  value={form.end}
                  onChange={(e) => setForm({ ...form, end: e.target.value })}
                />
              </label>
            </div>
          )}
          {error && <p role="alert">{error}</p>}
          {message && (
            <p role="status" className="tech-notice">
              {message}
            </p>
          )}
          <BusyButton
            type="submit"
            className="btn btn-primary"
            disabled={busy !== null || (form.repeat === 'WEEKLY' && !form.weekdays.length)}
            busy={busy === 'add'}
            busyLabel="Guardando…"
          >
            Guardar horario
          </BusyButton>
        </form>
      </section>
    </div>
  );
}
