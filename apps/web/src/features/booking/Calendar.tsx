import type { AccountUser, BookingResult } from '@instafix/contracts';
import { type CountryCode, normalizePhone } from '@instafix/contracts/src/phone';
import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../../lib/api';
import { PhoneField } from '../account/PhoneField';
import { SlotPicker, slotDate, slotTime } from './SlotPicker';

/**
 * Reserva propia de Instafix: Cliente → Instafix → Cal.com API. Cal.com solo agenda;
 * la confirmación al cliente la envía Instafix.
 */
export function Calendar() {
  const [user, setUser] = useState<AccountUser | null | undefined>(undefined);
  const [slot, setSlot] = useState<string | null>(null);
  const [country, setCountry] = useState<CountryCode>('EC');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<BookingResult | null>(null);
  useEffect(() => {
    api<AccountUser>('auth/me')
      .then(setUser)
      .catch(() => setUser(null));
  }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!slot) {
      setError('Elige un día y una hora.');
      return;
    }
    const data = new FormData(event.currentTarget);
    const raw = String(data.get('phone') ?? '');
    setBusy(true);
    setError('');
    try {
      setResult(
        await api<BookingResult>('booking', {
          method: 'POST',
          body: JSON.stringify({
            start: slot,
            request: data.get('request'),
            whatsappConsent: data.get('whatsappConsent') === 'on',
            ...(user
              ? {}
              : {
                  name: data.get('name'),
                  email: data.get('email') || '',
                  phone: normalizePhone(raw, country) ?? raw,
                }),
          }),
        }),
      );
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setSlot(null);
      setError(e instanceof Error ? e.message : 'No pudimos agendar tu cita.');
    } finally {
      setBusy(false);
    }
  }
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
          Elige el horario y cuéntanos qué necesita tu equipo.
          <br />
          Te confirmamos por correo y WhatsApp.
        </p>
      </div>
      {result ? (
        <div className="booking-done" role="status">
          <p className="booking-check">✓</p>
          <h3>{result.status === 'CONFIRMED' ? 'Tu cita está confirmada' : 'Tu cita fue agendada'}</h3>
          <p>
            <strong>{slotDate(result.startsAt)}</strong> · Hora estimada{' '}
            <strong>{slotTime(result.startsAt)}</strong>
          </p>
          {result.status === 'PENDING_LOCATION' && (
            <p>Te escribiremos por WhatsApp para pedirte la ubicación y confirmar la visita.</p>
          )}
          {result.email.status === 'SENT' && result.email.maskedEmail && (
            <p>Te enviamos la confirmación a {result.email.maskedEmail}.</p>
          )}
          {result.email.status === 'PENDING' && result.email.maskedEmail && (
            <p>Estamos enviando la confirmación a {result.email.maskedEmail}.</p>
          )}
          {result.account === 'LINKED' ? (
            <a className="button" href="#cuenta">
              Ver mi cita
            </a>
          ) : (
            <p className="small">
              Crea tu cuenta con este mismo WhatsApp para consultar y gestionar tus citas.{' '}
              <a href="#cuenta">Crear mi cuenta</a>
            </p>
          )}
        </div>
      ) : (
        <form className="booking-form" onSubmit={submit}>
          <fieldset>
            <legend>1. Día y hora</legend>
            <SlotPicker selected={slot} onSelect={setSlot} />
          </fieldset>
          <fieldset>
            <legend>2. Tus datos</legend>
            {user === undefined && <p role="status">Cargando…</p>}
            {user && (
              <div className="calendar-account-note">
                <p>
                  Reservarás como <strong>{user.name}</strong> · WhatsApp {user.phone}
                  {user.email ? ` · ${user.email}` : ''}. La cita aparecerá en Mi cuenta.
                </p>
              </div>
            )}
            {user === null && (
              <>
                <label>
                  Nombre y apellido
                  <input name="name" autoComplete="name" required minLength={2} maxLength={100} />
                </label>
                <PhoneField id="booking-phone" country={country} onCountry={setCountry} />
                <label>
                  Correo para la confirmación
                  <input
                    name="email"
                    type="email"
                    autoComplete="email"
                    maxLength={254}
                    placeholder="nombre@correo.com"
                  />
                </label>
                <p className="small">
                  ¿Ya tienes cuenta? <a href="#cuenta">Inicia sesión</a> para ver la cita en Mi
                  cuenta.
                </p>
              </>
            )}
            <label>
              ¿Qué necesitas?
              <textarea
                name="request"
                required
                minLength={3}
                maxLength={500}
                placeholder="Ej.: Mi PS5 se apaga después de jugar unos minutos."
              />
            </label>
            <label className="checkbox-label">
              <input type="checkbox" name="whatsappConsent" />
              Autorizo a InstaFix a enviarme por WhatsApp la confirmación y los recordatorios de
              esta cita.
            </label>
          </fieldset>
          {slot && (
            <p className="booking-summary">
              Visita: <strong>{slotDate(slot)}</strong> · <strong>{slotTime(slot)}</strong>
            </p>
          )}
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <button className="button" disabled={busy || user === undefined}>
            {busy ? 'Agendando…' : 'Agendar cita'}
          </button>
        </form>
      )}
    </section>
  );
}
