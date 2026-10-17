import type { AccountUser } from '@instafix/contracts';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { BookingFlow } from './BookingFlow';

/** Agenda pública: flujo propio de Instafix; Cal.com solo como motor de disponibilidad. */
export function Calendar() {
  const [user, setUser] = useState<AccountUser | null | undefined>(undefined);
  useEffect(() => {
    api<AccountUser>('auth/me')
      .then(setUser)
      .catch(() => setUser(null));
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
          Elige el día y la hora que prefieras.
          <br />
          Vamos a tu domicilio.
        </p>
      </div>
      {user === undefined ? (
        <p className="schedule-status" role="status">
          Preparando tu agenda…
        </p>
      ) : (
        <BookingFlow user={user} />
      )}
    </section>
  );
}
