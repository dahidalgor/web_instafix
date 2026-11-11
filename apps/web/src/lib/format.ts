export const money = (value: number) =>
  new Intl.NumberFormat('es-EC', { style: 'currency', currency: 'USD' }).format(value / 100);

/** «45 min», «1 h», «1 h 30 min». */
export function duration(minutes: number) {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/** Garantía legible: años o meses exactos cuando corresponde; si no, días. */
export function warranty(days: number) {
  if (days >= 365 && days % 365 === 0) return days === 365 ? '1 año' : `${days / 365} años`;
  if (days >= 30 && days % 30 === 0) return days === 30 ? '1 mes' : `${days / 30} meses`;
  return days === 1 ? '1 día' : `${days} días`;
}

/** Enlace de mapas (Google/Apple) guardado en la dirección de una cita, si lo hay. */
export function mapsLink(address?: string | null) {
  const url = address?.match(/https:\/\/[^\s]+/)?.[0];
  if (!url) return null;
  try {
    const host = new URL(url).hostname;
    return /(^|\.)(google\.[a-z.]+|goo\.gl|maps\.apple\.com)$/.test(host) ? url : null;
  } catch {
    return null;
  }
}

/** «hoy a las 14H00», «mañana a las 10H30» o «jue 13 nov a las 10H30» (hora de la cita). */
export function confirmByText(value: string, timeZone: string, now = new Date()) {
  const date = new Date(value);
  const day = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone }).format(d);
  const parts = new Intl.DateTimeFormat('es-EC', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const time = `${parts.find((p) => p.type === 'hour')?.value}H${parts.find((p) => p.type === 'minute')?.value}`;
  const when =
    day(date) === day(now)
      ? 'hoy'
      : day(date) === day(new Date(now.getTime() + 86400000))
        ? 'mañana'
        : new Intl.DateTimeFormat('es-EC', {
            timeZone,
            weekday: 'short',
            day: 'numeric',
            month: 'short',
          })
            .format(date)
            .replace(/\./g, '');
  return `${when} a las ${time}`;
}
