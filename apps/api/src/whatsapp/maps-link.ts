/**
 * Ubicación escrita en un mensaje de texto: enlace de Google Maps (también los cortos
 * maps.app.goo.gl), de Apple Maps o coordenadas «lat, lng». La ubicación nativa de WhatsApp
 * no pasa por aquí: llega ya con coordenadas.
 */
export type TextLocation = {
  latitude?: number;
  longitude?: number;
  name?: string;
  /** Enlace original (o resuelto) para abrirlo si no se obtuvieron coordenadas. */
  url?: string;
};

const coordinate = String.raw`(-?\d{1,3}(?:\.\d+)?)`;
const pair = new RegExp(String.raw`^\s*(?:loc:)?\s*${coordinate}\s*,\s*${coordinate}\s*$`);
// En un texto suelto se exigen decimales («-0.1807, -78.4678»): «1, 2» es una respuesta, no un lugar.
const precise = String.raw`(-?\d{1,3}\.\d{3,})`;
const textPair = new RegExp(String.raw`^\s*${precise}\s*,\s*${precise}\s*$`);

function valid(latitude: number, longitude: number) {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    Math.abs(latitude) <= 90 &&
    Math.abs(longitude) <= 180 &&
    // 0,0 es un valor por defecto, no una dirección real.
    !(latitude === 0 && longitude === 0)
  );
}
function fromPair(value: string | null | undefined, pattern = pair) {
  const match = value?.match(pattern);
  if (!match) return null;
  const [latitude, longitude] = [Number(match[1]), Number(match[2])];
  return valid(latitude, longitude) ? { latitude, longitude } : null;
}

const isGoogleMaps = (url: URL) =>
  (/(^|\.)google\.[a-z]{2,3}(\.[a-z]{2})?$/.test(url.hostname) &&
    (url.hostname.startsWith('maps.') || url.pathname.startsWith('/maps'))) ||
  url.hostname === 'maps.app.goo.gl' ||
  (url.hostname === 'goo.gl' && url.pathname.startsWith('/maps'));
const isShortLink = (url: URL) =>
  url.hostname === 'maps.app.goo.gl' ||
  (url.hostname === 'goo.gl' && url.pathname.startsWith('/maps'));
const isAppleMaps = (url: URL) => url.hostname === 'maps.apple.com';

/** Coordenadas de un enlace de mapas ya expandido. */
export function locationFromMapsUrl(url: URL): TextLocation | null {
  if (!isGoogleMaps(url) && !isAppleMaps(url)) return null;
  const href = decodeURIComponent(url.href);
  // Pin exacto del lugar (!3d lat !4d lng) antes que el centro de la vista (@lat,lng).
  const pin = href.match(new RegExp(String.raw`!3d${coordinate}!4d${coordinate}`));
  const view = href.match(new RegExp(String.raw`@${coordinate},${coordinate}`));
  const found =
    (pin && valid(Number(pin[1]), Number(pin[2]))
      ? { latitude: Number(pin[1]), longitude: Number(pin[2]) }
      : null) ??
    ['q', 'query', 'll', 'sll', 'destination', 'daddr', 'center', 'coordinate']
      .map((key) => fromPair(url.searchParams.get(key)))
      .find(Boolean) ??
    (view && valid(Number(view[1]), Number(view[2]))
      ? { latitude: Number(view[1]), longitude: Number(view[2]) }
      : null);
  const place = url.pathname.match(/\/maps\/place\/([^/]+)/)?.[1];
  const name = place
    ? decodeURIComponent(place).replace(/\+/g, ' ').trim().slice(0, 200)
    : !found && url.searchParams.get('q')
      ? url.searchParams.get('q')!.slice(0, 200)
      : undefined;
  return { ...(found ?? {}), ...(name ? { name } : {}), url: url.href.slice(0, 500) };
}

/**
 * Sigue las redirecciones de un enlace corto, solo entre dominios de Google y por HTTPS, sin
 * descargar la página. Devuelve la URL final o null.
 */
export async function expandShortLink(url: URL, fetcher: typeof fetch = fetch) {
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    if (!isShortLink(current) && isGoogleMaps(current)) return current;
    const response = await fetcher(current.href, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
      headers: { 'User-Agent': 'Mozilla/5.0 (Instafix; ubicación de cita)' },
    });
    await response.body?.cancel().catch(() => {});
    const location = response.headers.get('location');
    if (response.status < 300 || response.status >= 400 || !location) return null;
    const next = new URL(location, current);
    const google =
      /(^|\.)google\.[a-z]{2,3}(\.[a-z]{2})?$/.test(next.hostname) || isShortLink(next);
    if (next.protocol !== 'https:' || !google) return null;
    // La página de consentimiento de Google lleva el destino en ?continue=.
    const target = next.hostname.startsWith('consent.') ? next.searchParams.get('continue') : null;
    current = target ? new URL(target) : next;
  }
  return isGoogleMaps(current) ? current : null;
}

/** Busca una ubicación en un texto del cliente. Nunca lanza: sin ubicación devuelve null. */
export async function locationFromText(
  text: string,
  fetcher: typeof fetch = fetch,
): Promise<TextLocation | null> {
  const coordinates = fromPair(text.replace(/[()]/g, ''), textPair);
  if (coordinates) return coordinates;
  for (const raw of text.match(/https?:\/\/[^\s<>"']+/g) ?? []) {
    let url: URL;
    try {
      url = new URL(raw.replace(/[).,;!?]+$/, ''));
    } catch {
      continue;
    }
    if (!isGoogleMaps(url) && !isAppleMaps(url)) continue;
    if (isShortLink(url)) {
      const expanded = await expandShortLink(url, fetcher).catch(() => null);
      // Si no se puede expandir, el técnico aún puede abrir el enlace original.
      if (!expanded) return { url: url.href.slice(0, 500) };
      return { ...locationFromMapsUrl(expanded), url: url.href.slice(0, 500) };
    }
    const found = locationFromMapsUrl(url);
    if (found) return found;
  }
  return null;
}
