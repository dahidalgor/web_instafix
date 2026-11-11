import { addDays, busyBlockHours, weekdayNames } from '@instafix/contracts';
import { useMemo, useState, type ReactNode } from 'react';

/** Algo que ocupa tiempo en un día (hora de Ecuador, minutos desde las 00H00). */
export type CalendarItem = {
  id: string;
  day: string;
  startMinute: number;
  endMinute: number;
  title: string;
  /** Texto extra del detalle (p. ej. a quién pertenece). */
  detail?: string;
  /** busy = horario ocupado (rayado); visit = visita confirmada (sólido). */
  kind: 'busy' | 'visit';
  /** Color de la persona (vista del equipo); sin color se usa el del tipo. */
  color?: string;
};

const DEFAULT_START = 7;
const DEFAULT_END = 22;
const shortDays = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const monthDay = (day: string, month: 'short' | 'long' = 'short') =>
  new Intl.DateTimeFormat('es-EC', { timeZone: 'UTC', day: 'numeric', month })
    .format(new Date(`${day}T12:00:00Z`))
    .replace(/\./g, '');
const hhmm = (minutes: number) =>
  `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}H${String(minutes % 60).padStart(2, '0')}`;
const isAllDay = (item: CalendarItem) => item.startMinute <= 0 && item.endMinute >= 1440;
export const todayInEcuador = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Guayaquil' }).format();

/** Carriles para que dos cosas a la misma hora queden lado a lado, sin taparse. */
function withLanes(items: CalendarItem[]) {
  const sorted = [...items].sort(
    (a, b) => a.startMinute - b.startMinute || b.endMinute - a.endMinute,
  );
  const placed: { item: CalendarItem; lane: number; lanes: number }[] = [];
  let group: typeof placed = [];
  let groupEnd = -1;
  const close = () => {
    const lanes = Math.max(1, ...group.map((g) => g.lane + 1));
    for (const g of group) g.lanes = lanes;
    group = [];
  };
  for (const item of sorted) {
    if (item.startMinute >= groupEnd) {
      close();
      groupEnd = -1;
    }
    const busy = new Set(
      group.filter((g) => g.item.endMinute > item.startMinute).map((g) => g.lane),
    );
    let lane = 0;
    while (busy.has(lane)) lane++;
    const entry = { item, lane, lanes: 1 };
    group.push(entry);
    placed.push(entry);
    groupEnd = Math.max(groupEnd, item.endMinute);
  }
  close();
  return placed;
}

/**
 * Calendario semanal (lunes a domingo) de horarios ocupados y visitas. En el teléfono se desliza
 * de lado; al tocar un bloque se ve su detalle debajo.
 */
export function WeekCalendar({
  weekStart,
  items,
  onWeekChange,
  legend,
  loading,
}: {
  weekStart: string;
  items: CalendarItem[];
  onWeekChange: (weekStart: string) => void;
  legend?: ReactNode;
  loading?: boolean;
}) {
  const [selected, setSelected] = useState<CalendarItem | null>(null);
  const today = todayInEcuador();
  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart],
  );
  const timed = items.filter((item) => !isAllDay(item));
  const startHour = Math.min(DEFAULT_START, ...timed.map((i) => Math.floor(i.startMinute / 60)));
  const endHour = Math.max(DEFAULT_END, ...timed.map((i) => Math.ceil(i.endMinute / 60)));
  const hours = Array.from({ length: endHour - startHour }, (_, i) => startHour + i);
  const allDay = items.filter(isAllDay);
  const current = selected && items.some((i) => i.id === selected.id) ? selected : null;
  const range = `${monthDay(days[0])} – ${monthDay(days[6])}`;

  const block = (entry: { item: CalendarItem; lane: number; lanes: number }) => {
    const { item, lane, lanes } = entry;
    const from = Math.max(item.startMinute, startHour * 60);
    const to = Math.min(item.endMinute, endHour * 60);
    const label = `${item.title}, ${hhmm(item.startMinute)} a ${hhmm(item.endMinute)}${item.detail ? `, ${item.detail}` : ''}`;
    return (
      <button
        key={item.id}
        type="button"
        className={`week-item is-${item.kind} ${item.color ? 'has-color' : ''} ${current?.id === item.id ? 'is-selected' : ''}`}
        style={{
          top: `calc(${(from - startHour * 60) / 60} * var(--week-hour))`,
          height: `calc(${(to - from) / 60} * var(--week-hour) - 2px)`,
          left: `calc(${(lane / lanes) * 100}% + 1px)`,
          width: `calc(${100 / lanes}% - 2px)`,
          ...(item.color ? { ['--item-color' as string]: item.color } : {}),
        }}
        aria-label={label}
        title={label}
        onClick={() => setSelected(current?.id === item.id ? null : item)}
      >
        <strong>{item.title}</strong>
        <span>{hhmm(item.startMinute)}</span>
      </button>
    );
  };

  return (
    <div className="week-calendar">
      <div className="week-nav">
        <button
          type="button"
          className="week-nav-arrow"
          aria-label="Semana anterior"
          onClick={() => onWeekChange(addDays(weekStart, -7))}
        >
          ‹
        </button>
        <strong aria-live="polite">{range}</strong>
        <button
          type="button"
          className="week-nav-arrow"
          aria-label="Semana siguiente"
          onClick={() => onWeekChange(addDays(weekStart, 7))}
        >
          ›
        </button>
        {!days.includes(today) && (
          <button
            type="button"
            className="btn btn-ghost btn-small week-nav-today"
            onClick={() => onWeekChange(today)}
          >
            Esta semana
          </button>
        )}
      </div>
      {legend && <div className="week-legend">{legend}</div>}

      <div className={`week-scroll ${loading ? 'is-loading' : ''}`}>
        <div className="week-grid" style={{ ['--week-hours' as string]: hours.length }}>
          <div className="week-corner" aria-hidden="true" />
          {days.map((day) => (
            <div key={day} className={`week-day-head ${day === today ? 'is-today' : ''}`}>
              <span>{shortDays[new Date(`${day}T12:00:00Z`).getUTCDay()]}</span>
              <strong>{Number(day.slice(8))}</strong>
            </div>
          ))}

          {allDay.length > 0 && (
            <>
              <div className="week-allday-label">Día</div>
              {days.map((day) => (
                <div key={day} className="week-allday">
                  {allDay
                    .filter((item) => item.day === day)
                    .map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className={`week-chip is-${item.kind} ${item.color ? 'has-color' : ''} ${current?.id === item.id ? 'is-selected' : ''}`}
                        style={item.color ? { ['--item-color' as string]: item.color } : undefined}
                        title={`${item.title} · todo el día${item.detail ? ` · ${item.detail}` : ''}`}
                        onClick={() => setSelected(current?.id === item.id ? null : item)}
                      >
                        {item.title}
                      </button>
                    ))}
                </div>
              ))}
            </>
          )}

          <div className="week-hours" aria-hidden="true">
            {hours.map((hour) => (
              <span key={hour}>{String(hour).padStart(2, '0')}</span>
            ))}
          </div>
          {days.map((day) => (
            <div key={day} className={`week-col ${day === today ? 'is-today' : ''}`}>
              {withLanes(timed.filter((item) => item.day === day)).map(block)}
            </div>
          ))}
        </div>
      </div>

      <div className="week-detail" aria-live="polite">
        {current ? (
          <>
            <strong>{current.title}</strong>
            <span>
              {weekdayNames[new Date(`${current.day}T12:00:00Z`).getUTCDay()]}{' '}
              {monthDay(current.day, 'long')} ·{' '}
              {isAllDay(current) ? 'Todo el día' : busyBlockHours(current)}
              {current.detail ? ` · ${current.detail}` : ''}
            </span>
          </>
        ) : (
          <span>Toca un bloque para ver el detalle.</span>
        )}
      </div>
    </div>
  );
}
