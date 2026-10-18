import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  addMonths,
  formatDay,
  formatMonth,
  formatTime,
  monthGrid,
  monthOf,
  monthRange,
  todayKey,
} from './booking-time';

/** Horario ofrecido por Cal.com (inicio en ISO). */
export type BookingSlot = { start: string };
export type FetchAvailability = (
  start: string,
  end: string,
) => Promise<Record<string, BookingSlot[]>>;

const weekdays = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];
const weekdayNames = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
// La agenda se ofrece hasta tres meses por delante.
const MONTHS_AHEAD = 3;

type Props = {
  fetchAvailability: FetchAvailability;
  selectedDay: string | null;
  selectedSlot: BookingSlot | null;
  onDayChange: (day: string) => void;
  onSlotChange: (slot: BookingSlot | null) => void;
  /** Horario que acaba de ocuparse; se muestra un aviso y se recargan los horarios. */
  takenSlot?: string | null;
  /** Cambiarlo obliga a volver a consultar la disponibilidad. */
  refreshKey?: number;
};

export function ScheduleStep({
  fetchAvailability,
  selectedDay,
  selectedSlot,
  onDayChange,
  onSlotChange,
  takenSlot,
  refreshKey = 0,
}: Props) {
  const today = todayKey();
  const firstMonth = monthOf(today);
  const lastMonth = addMonths(firstMonth, MONTHS_AHEAD - 1);
  const [month, setMonth] = useState(() => (selectedDay ? monthOf(selectedDay) : firstMonth));
  const [monthDays, setMonthDays] = useState<Record<string, number> | null>(null);
  const [monthError, setMonthError] = useState('');
  const [monthAttempt, setMonthAttempt] = useState(0);
  const [slots, setSlots] = useState<BookingSlot[] | null>(null);
  const [slotsError, setSlotsError] = useState('');
  const [slotsAttempt, setSlotsAttempt] = useState(0);
  const dayButtons = useRef(new Map<string, HTMLButtonElement>());

  // Disponibilidad del mes: solo indica qué días tienen horarios.
  useEffect(() => {
    let active = true;
    setMonthDays(null);
    setMonthError('');
    const { start, end } = monthRange(month);
    fetchAvailability(start < today ? today : start, end)
      .then((days) => {
        if (!active) return;
        setMonthDays(Object.fromEntries(Object.entries(days).map(([d, list]) => [d, list.length])));
      })
      .catch((e: Error) => active && setMonthError(e.message));
    return () => {
      active = false;
    };
  }, [month, monthAttempt, refreshKey, fetchAvailability, today]);

  // Horarios del día: siempre consulta fresca, sin caché.
  useEffect(() => {
    if (!selectedDay) {
      setSlots(null);
      return;
    }
    let active = true;
    setSlots(null);
    setSlotsError('');
    fetchAvailability(selectedDay, selectedDay)
      .then((days) => {
        if (!active) return;
        const list = days[selectedDay] ?? [];
        setSlots(list);
        setMonthDays((current) => (current ? { ...current, [selectedDay]: list.length } : current));
        if (selectedSlot && !list.some((slot) => slot.start === selectedSlot.start))
          onSlotChange(null);
      })
      .catch((e: Error) => active && setSlotsError(e.message));
    return () => {
      active = false;
    };
    // selectedSlot/onSlotChange se leen solo para limpiar una selección que ya no existe.
  }, [selectedDay, slotsAttempt, refreshKey, fetchAvailability]);

  const choose = useCallback(
    (day: string) => {
      if (day !== selectedDay) onSlotChange(null);
      onDayChange(day);
    },
    [onDayChange, onSlotChange, selectedDay],
  );

  const cells = monthGrid(month);
  const enabled = (day: string) => day >= today && Boolean(monthDays?.[day]);
  const firstAvailable = monthDays ? Object.keys(monthDays).filter(enabled).sort()[0] : undefined;
  const focusTarget = selectedDay && monthOf(selectedDay) === month ? selectedDay : firstAvailable;

  function onGridKey(event: KeyboardEvent<HTMLDivElement>) {
    const moves: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -7,
      ArrowDown: 7,
    };
    const delta = moves[event.key];
    const current = (event.target as HTMLElement).dataset.day;
    if (!delta || !current) return;
    event.preventDefault();
    const days = cells.filter((d): d is string => Boolean(d));
    let index = days.indexOf(current) + delta;
    while (index >= 0 && index < days.length && !enabled(days[index])) index += Math.sign(delta);
    const next = days[index];
    if (next) dayButtons.current.get(next)?.focus();
  }

  const monthHasNone = monthDays !== null && !Object.keys(monthDays).some(enabled);

  return (
    <div className="schedule">
      <section className="month-calendar" aria-labelledby="month-title">
        <div className="month-header">
          <button
            type="button"
            className="month-nav"
            aria-label="Mes anterior"
            disabled={month <= firstMonth}
            onClick={() => setMonth(addMonths(month, -1))}
          >
            ‹
          </button>
          <h3 id="month-title" aria-live="polite">
            {formatMonth(month)}
          </h3>
          <button
            type="button"
            className="month-nav"
            aria-label="Mes siguiente"
            disabled={month >= lastMonth}
            onClick={() => setMonth(addMonths(month, 1))}
          >
            ›
          </button>
        </div>
        <div className="month-weekdays" aria-hidden="true">
          {weekdays.map((d) => (
            <span key={d}>{d}</span>
          ))}
        </div>
        <div
          className={'month-grid' + (monthDays === null && !monthError ? ' is-loading' : '')}
          role="group"
          aria-label={`Días de ${formatMonth(month)}`}
          aria-busy={monthDays === null}
          onKeyDown={onGridKey}
        >
          {cells.map((day, index) => {
            if (!day) return <span key={`gap-${index}`} className="month-gap" />;
            const count = monthDays?.[day] ?? 0;
            const past = day < today;
            const available = enabled(day);
            const selected = day === selectedDay;
            const weekday = weekdayNames[index % 7];
            return (
              <button
                key={day}
                type="button"
                data-day={day}
                ref={(node) => {
                  if (node) dayButtons.current.set(day, node);
                  else dayButtons.current.delete(day);
                }}
                className={
                  'month-day' +
                  (available ? ' is-available' : '') +
                  (selected ? ' is-selected' : '') +
                  (day === today ? ' is-today' : '')
                }
                disabled={!available}
                aria-pressed={selected}
                tabIndex={day === focusTarget ? 0 : -1}
                aria-label={`${weekday} ${Number(day.slice(8))}${
                  past
                    ? ', fecha pasada'
                    : available
                      ? `, ${count} horarios disponibles`
                      : ', sin horarios'
                }`}
                onClick={() => choose(day)}
              >
                <span>{Number(day.slice(8))}</span>
                {available && <i aria-hidden="true" />}
              </button>
            );
          })}
        </div>
        <div className="month-legend" aria-hidden="true">
          <span className="legend-available">Con horarios</span>
          <span className="legend-none">Sin disponibilidad</span>
        </div>
        {monthDays === null && !monthError && (
          <p className="schedule-status" role="status">
            Consultando disponibilidad…
          </p>
        )}
        {monthError && (
          <p className="schedule-status error" role="alert">
            {monthError}{' '}
            <button
              type="button"
              className="btn btn-ghost btn-small"
              onClick={() => setMonthAttempt((n) => n + 1)}
            >
              Reintentar
            </button>
          </p>
        )}
        {monthHasNone && (
          <p className="schedule-status" role="status">
            No quedan horarios en {formatMonth(month).toLowerCase()}.{' '}
            {month < lastMonth && (
              <button
                type="button"
                className="btn btn-secondary btn-small"
                onClick={() => setMonth(addMonths(month, 1))}
              >
                Ver el mes siguiente
              </button>
            )}
          </p>
        )}
      </section>

      <section className="slot-panel" aria-labelledby="slot-title" aria-live="polite">
        <p className="eyebrow">HORARIOS DISPONIBLES</p>
        <h3 id="slot-title">{selectedDay ? formatDay(selectedDay) : 'Elige un día'}</h3>
        {takenSlot && (
          <p className="slot-alert" role="alert">
            Las {formatTime(takenSlot)} acaban de dejar de estar disponibles. Selecciona otro
            horario.
          </p>
        )}
        {!selectedDay && (
          <p className="slot-hint">Los días marcados tienen horarios libres para la visita.</p>
        )}
        {selectedDay && slots === null && !slotsError && (
          <div className="slot-grid" role="status" aria-label="Cargando horarios">
            {Array.from({ length: 6 }, (_, i) => (
              <span key={i} className="slot-skeleton" />
            ))}
          </div>
        )}
        {slotsError && (
          <p className="schedule-status error" role="alert">
            {slotsError}{' '}
            <button
              type="button"
              className="btn btn-ghost btn-small"
              onClick={() => setSlotsAttempt((n) => n + 1)}
            >
              Reintentar
            </button>
          </p>
        )}
        {slots && !slots.length && (
          <p className="slot-hint">Este día ya no tiene horarios libres. Prueba con otra fecha.</p>
        )}
        {slots && slots.length > 0 && (
          <div className="slot-grid" role="group" aria-label="Horarios">
            {slots.map((slot) => {
              const selected = selectedSlot?.start === slot.start;
              return (
                <button
                  key={slot.start}
                  type="button"
                  className={'slot' + (selected ? ' is-selected' : '')}
                  aria-pressed={selected}
                  onClick={() => onSlotChange(slot)}
                >
                  {formatTime(slot.start)}
                </button>
              );
            })}
          </div>
        )}
        {slots && slots.length > 0 && (
          <p className="slot-hint">
            Hora de Ecuador continental. Es la hora de inicio de la visita.
          </p>
        )}
      </section>
    </div>
  );
}
