import Cal from '@calcom/embed-react';
import { useEffect, useState } from 'react';

export function Calendar() {
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
      <div className="calendar-container">
        <Cal
          key={`${attempt}-${theme}`}
          namespace={`instafix-${attempt}-${theme}`}
          calLink="instafix/agenda-tu-cita-con-instafix"
          calOrigin="https://cal.com"
          config={{ overlayCalendar: 'true', layout: 'month_view', theme }}
          className="calendar-embed"
        />
      </div>
      <div className="calendar-retry">
        <span>¿El calendario tarda en aparecer?</span>
        <button type="button" onClick={() => setAttempt((value) => value + 1)}>
          Volver a cargar aquí
        </button>
      </div>
    </section>
  );
}
