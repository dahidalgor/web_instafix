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
