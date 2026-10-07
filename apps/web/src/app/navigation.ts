export const pages = [
  'inicio',
  'servicios',
  'quienes-somos',
  'como',
  'cuenta',
  'agenda',
  'garantia',
  'solicitud',
] as const;
export type Page = (typeof pages)[number];
export function resolvePage(hash: string): Page {
  const value = hash.replace(/^#/, '');
  if (value === 'nuestro-trabajo') return 'quienes-somos';
  return pages.includes(value as Page) ? (value as Page) : 'inicio';
}
