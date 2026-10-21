import { mapsLink } from '../../lib/format';

/** Campos de ubicación de una cita (los mismos en Mi cuenta, panel técnico y administración). */
export type LocationFields = {
  address?: string | null;
  locationArea?: string | null;
  locationName?: string | null;
  locationLatitude?: number | null;
  locationLongitude?: number | null;
  locationReceivedAt?: string | null;
  locationSource?: string | null;
};

const coordinates = (a: LocationFields) =>
  a.locationLatitude != null && a.locationLongitude != null
    ? { lat: a.locationLatitude, lng: a.locationLongitude }
    : null;

/**
 * Enlaces de mapas a partir de las coordenadas reales (fuente principal). URL universal de
 * Google Maps: abre la app del teléfono si está instalada y, si no, el navegador; funciona en
 * escritorio. Sin coordenadas se usa el enlace de mapas que envió el cliente, si existe. Nunca
 * se inventan coordenadas.
 */
export function locationLinks(a: LocationFields) {
  const point = coordinates(a);
  if (point) {
    const q = `${point.lat},${point.lng}`;
    return {
      view: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`,
      directions: `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(q)}`,
    };
  }
  const link = mapsLink(a.address);
  return link ? { view: link, directions: link } : null;
}

const looksLikeCoordinates = (text: string) => /^-?\d+\.\d+\s*,\s*-?\d+\.\d+$/.test(text.trim());

/** Texto principal: calle y sector, nombre del lugar o, si no hay, una descripción útil. */
export function locationSummary(a: LocationFields) {
  const point = coordinates(a);
  const written =
    a.address && !looksLikeCoordinates(a.address) && !mapsLink(a.address) ? a.address : '';
  if (a.locationArea) return { title: a.locationArea, detail: a.locationName || written || null };
  if (a.locationName) return { title: a.locationName, detail: written || null };
  if (point)
    return {
      title:
        a.locationSource === 'STAFF'
          ? 'Ubicación añadida por el equipo'
          : 'Ubicación compartida por WhatsApp',
      detail: written || null,
    };
  if (written) return { title: written, detail: null };
  if (a.locationReceivedAt || mapsLink(a.address))
    return { title: 'Enlace de ubicación recibido', detail: null };
  return null;
}

/**
 * Bloque «📍 Ubicación» de la tarjeta de una cita (dentro de su <dl>). Distingue la dirección
 * escrita de la ubicación compartida por WhatsApp y ofrece abrirla en mapas.
 */
export function AppointmentLocation({
  appointment,
  pending = 'Pendiente: el cliente la enviará por WhatsApp',
  directions = false,
}: {
  appointment: LocationFields;
  /** Texto cuando aún no hay ubicación. */
  pending?: string;
  /** Técnico: «Cómo llegar» además de «Abrir mapa». */
  directions?: boolean;
}) {
  const summary = locationSummary(appointment);
  const links = locationLinks(appointment);
  const gps = coordinates(appointment);
  return (
    <div className="appt-meta-wide appt-location">
      <dt>
        <span aria-hidden="true">📍</span> Ubicación
      </dt>
      <dd>
        {summary ? (
          <>
            <span className="appt-location-title">{summary.title}</span>
            {summary.detail && summary.detail !== summary.title && (
              <span className="appt-location-detail">
                {gps ? `Dirección indicada: ${summary.detail}` : summary.detail}
              </span>
            )}
            {gps && appointment.locationSource === 'WHATSAPP' && (
              <span className="appt-location-source">✓ Compartida por WhatsApp</span>
            )}
          </>
        ) : (
          <span className="appt-location-pending">{pending}</span>
        )}
        {links && (
          <span className="appt-location-actions">
            <a href={links.view} target="_blank" rel="noopener noreferrer">
              Abrir mapa<span className="visually-hidden"> (se abre en otra pestaña)</span>
            </a>
            {directions && gps && (
              <a href={links.directions} target="_blank" rel="noopener noreferrer">
                Cómo llegar<span className="visually-hidden"> (se abre en otra pestaña)</span>
              </a>
            )}
          </span>
        )}
      </dd>
    </div>
  );
}
