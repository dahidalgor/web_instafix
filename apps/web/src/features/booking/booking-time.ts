// La atención es presencial en Ecuador continental: el calendario siempre muestra esa zona,
// aunque el navegador esté configurado en otra.
export const bookingTimeZone = 'America/Guayaquil';
const zone = bookingTimeZone;

const dayKeyFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: zone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** YYYY-MM-DD de un instante en la zona de atención. */
export function dayKey(instant: Date | string | number) {
  return dayKeyFormat.format(new Date(instant));
}

export function todayKey() {
  return dayKey(Date.now());
}

/** YYYY-MM del mes que contiene el día. */
export function monthOf(day: string) {
  return day.slice(0, 7);
}

export function addMonths(month: string, delta: number) {
  const [y, m] = month.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function monthRange(month: string) {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${month}-01`, end: `${month}-${String(last).padStart(2, '0')}`, days: last };
}

/** Celdas del mes empezando en lunes; null para los huecos del inicio. */
export function monthGrid(month: string) {
  const { days } = monthRange(month);
  const [y, m] = month.split('-').map(Number);
  const firstWeekday = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;
  const cells: (string | null)[] = Array.from({ length: firstWeekday }, () => null);
  for (let d = 1; d <= days; d++) cells.push(`${month}-${String(d).padStart(2, '0')}`);
  return cells;
}

const noonUtc = (day: string) => new Date(`${day}T12:00:00Z`);

export function formatMonth(month: string) {
  const text = new Intl.DateTimeFormat('es-EC', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(noonUtc(`${month}-01`));
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** «sábado, 24 de octubre» */
export function formatDay(day: string, withYear = false) {
  const text = new Intl.DateTimeFormat('es-EC', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    ...(withYear ? { year: 'numeric' } : {}),
    timeZone: 'UTC',
  }).format(noonUtc(day));
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** «15:30» en la zona de atención. */
export function formatTime(instant: string) {
  return new Intl.DateTimeFormat('es-EC', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: zone,
  }).format(new Date(instant));
}

export function newRequestKey() {
  return crypto.randomUUID();
}
