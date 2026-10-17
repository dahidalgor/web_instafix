import type { BookingConfig } from '@instafix/contracts';
import { useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { BookingFlow } from './BookingFlow';
import { LegacyCalendar } from './LegacyCalendar';

/**
 * Agenda pública. Usa el flujo propio (Cal.com solo como motor vía API) cuando el servidor
 * lo tiene configurado; si no, conserva temporalmente el formulario anterior.
 */
export function Calendar() {
  const [config, setConfig] = useState<BookingConfig | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setError('');
    const load = () => api<BookingConfig>('booking/config');
    // Un reintento automático cubre cortes breves (p. ej. un reinicio del servidor).
    load()
      .catch((e) =>
        e instanceof ApiError && e.status === 401
          ? Promise.reject(e)
          : new Promise<BookingConfig>((resolve, reject) =>
              setTimeout(() => load().then(resolve, reject), 1500),
            ),
      )
      .then((value) => active && setConfig(value))
      .catch((e) => {
        if (!active) return;
        setError(
          e instanceof ApiError && e.status === 401
            ? 'Tu sesión caducó. Inicia sesión de nuevo para reservar con tu cuenta.'
            : 'No pudimos cargar la agenda. Revisa tu conexión.',
        );
      });
    return () => {
      active = false;
    };
  }, [attempt]);

  return (
    <section id="agenda" className="calendar-section" aria-labelledby="calendar-title">
      <div className="section-head">
        <div>
          <p className="eyebrow">NOS ADAPTAMOS A TU TIEMPO</p>
          <h2 id="calendar-title">
            Agenda tu cita
            <br />
            con <em>InstaFix.</em>
          </h2>
        </div>
        <p>
          Elige el día y la hora que prefieras.
          <br />
          Vamos a tu domicilio.
        </p>
      </div>
      {error && (
        <div className="booking-error" role="alert">
          <p>{error}</p>
          <a href="#cuenta" className="text-button">
            Ir a Mi cuenta
          </a>{' '}
          <button type="button" className="text-button" onClick={() => setAttempt((n) => n + 1)}>
            Reintentar
          </button>
        </div>
      )}
      {!config && !error && (
        <p className="schedule-status" role="status">
          Preparando tu agenda…
        </p>
      )}
      {config?.mode === 'native' && <BookingFlow config={config} />}
      {config?.mode === 'legacy' && <LegacyCalendar />}
    </section>
  );
}
