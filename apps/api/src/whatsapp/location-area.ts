import { logEvent } from '../common/log-event';
import { db } from '../database/client';

/**
 * Calle y sector de la ubicación del cliente (geocodificación inversa con OpenStreetMap
 * Nominatim: gratuito, sin clave). Solo se envían las coordenadas, nunca datos del cliente.
 * Política de Nominatim: identificarse y no superar 1 petición por segundo.
 * Se desactiva con REVERSE_GEOCODING_ENABLED=false.
 */
const ENDPOINT = 'https://nominatim.openstreetmap.org/reverse';
export const reverseGeocodingEnabled = () => process.env.REVERSE_GEOCODING_ENABLED !== 'false';

type NominatimAddress = Partial<
  Record<
    | 'road'
    | 'pedestrian'
    | 'footway'
    | 'neighbourhood'
    | 'quarter'
    | 'suburb'
    | 'city_district'
    | 'hamlet'
    | 'village'
    | 'town'
    | 'city'
    | 'municipality'
    | 'county',
    string
  >
>;

/** «Av. Amazonas · La Carolina, Quito» a partir de la respuesta de Nominatim. */
export function formatArea(address: NominatimAddress) {
  const street = address.road || address.pedestrian || address.footway;
  const sector =
    address.neighbourhood ||
    address.quarter ||
    address.suburb ||
    address.city_district ||
    address.hamlet;
  const city =
    address.city || address.town || address.village || address.municipality || address.county;
  const place = [sector, city].filter((v, i, all) => v && all.indexOf(v) === i).join(', ');
  return [street, place].filter(Boolean).join(' · ').slice(0, 200) || null;
}

export async function reverseGeocode(
  latitude: number,
  longitude: number,
  fetcher: typeof fetch = fetch,
) {
  const url = new URL(ENDPOINT);
  url.search = new URLSearchParams({
    format: 'jsonv2',
    lat: String(latitude),
    lon: String(longitude),
    zoom: '18',
    addressdetails: '1',
    'accept-language': 'es',
  }).toString();
  const response = await fetcher(url, {
    signal: AbortSignal.timeout(6000),
    headers: {
      'User-Agent': `Instafix/1.0 (${process.env.PUBLIC_WEB_URL || 'https://instafix.ec'})`,
      Accept: 'application/json',
    },
  });
  if (!response.ok) throw new Error(`Nominatim ${response.status}`);
  const body = (await response.json()) as { address?: NominatimAddress; error?: string };
  return body.address ? formatArea(body.address) : null;
}

let lastRequest = 0;
/**
 * Completa locationArea de una cita. Nunca lanza: la ubicación ya está guardada y el sector es
 * informativo. Sin resultado se guarda '' para no repetir la consulta; un fallo de red deja
 * NULL y el worker lo reintenta más tarde.
 */
export async function fillLocationArea(appointmentId: string, fetcher: typeof fetch = fetch) {
  if (!reverseGeocodingEnabled()) return null;
  const appointment = await db.appointment.findUnique({
    where: { id: appointmentId },
    select: { locationLatitude: true, locationLongitude: true, locationArea: true },
  });
  if (
    !appointment ||
    appointment.locationArea !== null ||
    appointment.locationLatitude === null ||
    appointment.locationLongitude === null
  )
    return appointment?.locationArea ?? null;
  // Una petición por segundo como máximo (política de Nominatim).
  const wait = lastRequest + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequest = Date.now();
  try {
    const area = await reverseGeocode(
      appointment.locationLatitude,
      appointment.locationLongitude,
      fetcher,
    );
    // Solo si las coordenadas no cambiaron mientras tanto.
    await db.appointment.updateMany({
      where: {
        id: appointmentId,
        locationArea: null,
        locationLatitude: appointment.locationLatitude,
        locationLongitude: appointment.locationLongitude,
      },
      data: { locationArea: area ?? '' },
    });
    return area;
  } catch (error) {
    logEvent(
      'location.area_failed',
      { appointmentId, reason: error instanceof Error ? error.message.slice(0, 200) : 'Error' },
      'warn',
    );
    return null;
  }
}

/** Reintento de las citas con ubicación reciente cuyo sector aún no se obtuvo (una por vuelta). */
let lastBackfill = 0;
export async function fillPendingLocationAreas(fetcher: typeof fetch = fetch, force = false) {
  if (!reverseGeocodingEnabled()) return;
  // Como mucho cada 5 minutos: si Nominatim falla, no se insiste en cada vuelta del worker.
  if (!force && Date.now() - lastBackfill < 300000) return;
  lastBackfill = Date.now();
  const pending = await db.appointment.findFirst({
    where: {
      locationArea: null,
      locationLatitude: { not: null },
      locationLongitude: { not: null },
      locationReceivedAt: { gt: new Date(Date.now() - 2 * 86400000) },
    },
    orderBy: { locationReceivedAt: 'desc' },
    select: { id: true },
  });
  if (pending) await fillLocationArea(pending.id, fetcher);
}
