import type { AccountUser } from '@instafix/contracts';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { Skeleton, SkeletonGroup } from '../../components/ui/Skeleton';
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
        <SkeletonGroup label="Preparando tu agenda…" className="booking-flow">
          <div className="skeleton-row booking-skeleton-steps">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} width="23%" height={6} radius={999} />
            ))}
          </div>
          <Skeleton width={220} height={26} />
          <div className="schedule">
            <div className="booking-skeleton-month">
              {Array.from({ length: 35 }, (_, i) => (
                <Skeleton key={i} height={44} radius={10} />
              ))}
            </div>
            <div className="slot-panel">
              <Skeleton width={140} height={12} />
              <Skeleton width="70%" height={22} />
              <div className="slot-grid">
                {[0, 1, 2, 3].map((i) => (
                  <Skeleton key={i} height={50} radius={10} />
                ))}
              </div>
            </div>
          </div>
        </SkeletonGroup>
      ) : (
        <BookingFlow user={user} />
      )}
    </section>
  );
}
