import { homeSections, publicPages } from '@instafix/contracts/src/site';
export const pages = publicPages;
export type Page = (typeof pages)[number];
export type HomeSection = (typeof homeSections)[number];

function hashPath(hash: string) {
  return hash.replace(/^#/, '').split('?')[0];
}
export function resolvePage(hash: string): Page {
  const value = hashPath(hash);
  // Antiguas páginas «Quiénes somos» y «Cómo funciona»: ahora son secciones de Inicio.
  if ((homeSections as readonly string[]).includes(value)) return 'inicio';
  // Enlaces de correo: la recuperación se gestiona en Mi cuenta; la verificación, en Ajustes.
  if (value === 'restablecer') return 'cuenta';
  if (value === 'verificar-correo') return 'ajustes';
  return pages.includes(value as Page) ? (value as Page) : 'inicio';
}
/** Sección de Inicio a la que debe desplazarse un enlace (#como, #nuestro-trabajo…). */
export function homeSection(hash: string): HomeSection | null {
  const value = hashPath(hash);
  return (homeSections as readonly string[]).includes(value) ? (value as HomeSection) : null;
}
