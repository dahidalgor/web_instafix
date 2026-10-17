import { useEffect, useState } from 'react';
import { api } from '../../lib/api';

const zone = 'America/Guayaquil';
const ecuadorDay = (date: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(date); // YYYY-MM-DD
const dayLabel = (day: string) => {
  const date = new Date(`${day}T12:00:00-05:00`);
  return {
    weekday: new Intl.DateTimeFormat('es-EC', { weekday: 'short', timeZone: zone }).format(date),
    number: new Intl.DateTimeFormat('es-EC', { day: 'numeric', timeZone: zone }).format(date),
    month: new Intl.DateTimeFormat('es-EC', { month: 'short', timeZone: zone }).format(date),
  };
};
export const slotTime = (iso: string) =>
  new Intl.DateTimeFormat('es-EC', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: zone,
  }).format(new Date(iso));
export const slotDate = (iso: string) => {
  const text = new Intl.DateTimeFormat('es-EC', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: zone,
  }).format(new Date(iso));
  return text.charAt(0).toUpperCase() + text.slice(1);
};

/** Disponibilidad real consultada a Cal.com a través de la API de Instafix. */
export function SlotPicker({
  selected,
  onSelect,
}: {
  selected: string | null;
  onSelect: (iso: string) => void;
}) {
  const [days, setDays] = useState<Record<string, string[]> | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setError('');
    setDays(null);
    const from = ecuadorDay(new Date());
    const to = ecuadorDay(new Date(Date.now() + 20 * 86400000));
    api<{ days: Record<string, string[]> }>(`booking/slots?from=${from}&to=${to}`)
      .then((result) => {
        if (!active) return;
        const available = Object.fromEntries(
          Object.entries(result.days).filter(([, slots]) => slots.length),
        );
        setDays(available);
        setDay((current) => current ?? Object.keys(available).sort()[0] ?? null);
      })
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [attempt]);
  if (error)
    return (
      <div role="alert" className="slot-state">
        <p>{error}</p>
        <button type="button" onClick={() => setAttempt((value) => value + 1)}>
          Reintentar
        </button>
      </div>
    );
  if (!days)
    return (
      <p role="status" className="slot-state">
        Consultando horarios disponibles…
      </p>
    );
  const sorted = Object.keys(days).sort();
  if (!sorted.length)
    return (
      <p role="status" className="slot-state">
        No hay horarios disponibles en las próximas semanas. Escríbenos por WhatsApp y
        buscaremos un espacio.
      </p>
    );
  return (
    <div className="slot-picker">
      <div className="slot-days" role="listbox" aria-label="Día de la visita">
        {sorted.map((value) => {
          const label = dayLabel(value);
          return (
            <button
              type="button"
              role="option"
              key={value}
              aria-selected={value === day}
              className={value === day ? 'active' : ''}
              onClick={() => setDay(value)}
            >
              <span>{label.weekday}</span>
              <strong>{label.number}</strong>
              <span>{label.month}</span>
            </button>
          );
        })}
      </div>
      {day && (
        <div className="slot-times" role="listbox" aria-label="Hora estimada de llegada">
          {days[day].map((iso) => (
            <button
              type="button"
              role="option"
              key={iso}
              aria-selected={iso === selected}
              className={iso === selected ? 'active' : ''}
              onClick={() => onSelect(iso)}
            >
              {slotTime(iso)}
            </button>
          ))}
        </div>
      )}
      <p className="small">Horario de Ecuador continental. La hora es una llegada estimada.</p>
    </div>
  );
}
