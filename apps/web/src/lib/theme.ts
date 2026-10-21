/**
 * Tema de la web: claro, oscuro o según el sistema (por defecto). Se guarda solo en este
 * navegador. index.html aplica el tema antes de pintar (sin parpadeo); aquí se cambia y se
 * sigue al sistema cuando la preferencia es «sistema».
 */
export type ThemePreference = 'light' | 'dark' | 'system';
export const THEME_KEY = 'instafix:theme';
const THEME_EVENT = 'instafix:theme-change';
const systemDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;

export function themePreference(): ThemePreference {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(preference = themePreference()) {
  const dark = preference === 'dark' || (preference === 'system' && systemDark());
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', dark ? '#111222' : '#111630');
}

export function setThemePreference(preference: ThemePreference) {
  try {
    if (preference === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, preference);
  } catch {
    // Almacenamiento bloqueado: se aplica solo en esta visita.
  }
  applyTheme(preference);
  window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: preference }));
}

/** Sigue los cambios del sistema mientras la preferencia sea «sistema». */
export function watchSystemTheme() {
  const query = window.matchMedia('(prefers-color-scheme: dark)');
  const update = () => {
    if (themePreference() === 'system') applyTheme('system');
  };
  query.addEventListener('change', update);
  return () => query.removeEventListener('change', update);
}

export function onThemeChange(listener: (preference: ThemePreference) => void) {
  const handler = (event: Event) => listener((event as CustomEvent<ThemePreference>).detail);
  window.addEventListener(THEME_EVENT, handler);
  return () => window.removeEventListener(THEME_EVENT, handler);
}
