import Cal from '@calcom/embed-react';
import type { AccountUser } from '@instafix/contracts';
import { api, ApiError } from '../../lib/api';
import { useEffect, useState } from 'react';

export function Calendar() {
  const [context, setContext] = useState<{ token: string | null; user: AccountUser | null } | null>(
    null,
  );
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [theme, setTheme] = useState<'dark' | 'light'>(() =>
    window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
  );
  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const change = () => setTheme(query.matches ? 'dark' : 'light');
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    let active = true;
    setError('');
    setContext(null);
    api<{ token: string | null; user: AccountUser | null }>('booking/context', { method: 'POST' })
      .then((result) => {
        if (active) setContext(result);
      })
      .catch((e) => {
        if (!active) return;
        if (e instanceof ApiError && e.status === 401) setContext({ token: null, user: null });
        else setError('No pudimos cargar tus datos. Puedes reintentar o continuar como invitado.');
      });
    return () => {
      active = false;
    };
  }, [attempt]);
  const prefill = context?.user
    ? {
        name: context.user.name,
        email: context.user.email || '',
        attendeePhoneNumber: context.user.phone,
        ...(context.token ? { 'metadata[instafixReference]': context.token } : {}),
      }
    : {};
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
          Consulta los horarios y completa tu solicitud
          <br />
          sin salir de nuestra web.
        </p>
      </div>
      {context?.user && (
        <p className="calendar-account-note">
          Usaremos los datos de tu cuenta para rellenar la reserva. Revisa que sean correctos antes
          de confirmar.
        </p>
      )}
      {error && (
        <div role="alert">
          <p>{error}</p>
          <button
            onClick={() => {
              setError('');
              setContext({ token: null, user: null });
            }}
          >
            Continuar como invitado
          </button>
        </div>
      )}
      {!context && !error && <p role="status">Preparando tu agenda…</p>}
      {context && (
        <div className="calendar-container">
          <Cal
            key={`${attempt}-${theme}`}
            namespace={`instafix-${attempt}-${theme}`}
            calLink="instafix/agenda-tu-cita-con-instafix"
            calOrigin="https://cal.com"
            config={{ overlayCalendar: 'true', layout: 'month_view', theme, ...prefill }}
            className="calendar-embed"
          />
        </div>
      )}
      <div className="calendar-retry">
        <span>¿El calendario tarda en aparecer?</span>
        <button type="button" onClick={() => setAttempt((value) => value + 1)}>
          Volver a cargar aquí
        </button>
      </div>
    </section>
  );
}
