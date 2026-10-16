import { publicPages } from '@instafix/contracts/src/site';
export const pages = publicPages;
export type Page = (typeof pages)[number];
export function resolvePage(hash: string): Page {
  const value = hash.replace(/^#/, '').split('?')[0];
  if (value === 'nuestro-trabajo') return 'quienes-somos';
  return pages.includes(value as Page) ? (value as Page) : 'inicio';
}
