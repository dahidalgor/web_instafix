import type { AccountUser, BookingResult } from '@instafix/contracts';
import { maskPhone, normalizePhone, type CountryCode } from '@instafix/contracts/src/phone';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError } from '../../lib/api';
import { PhoneField } from '../account/PhoneField';
import { dayKey, formatDay, formatTime } from './booking-time';
import { ScheduleStep, type BookingSlot, type FetchAvailability } from './ScheduleStep';

const DRAFT_KEY = 'instafix:booking-draft';

type Step = 'schedule' | 'request' | 'contact' | 'review' | 'done';
const steps: { id: Exclude<Step, 'done'>; label: string }[] = [
  { id: 'schedule', label: 'Fecha y hora' },
  { id: 'request', label: 'Tu solicitud' },
  { id: 'contact', label: 'Contacto' },
  { id: 'review', label: 'Confirmar' },
];
type Guest = { firstName: string; lastName: string; phone: string; email: string };
const nameOk = (value: string) => /^[\p{L}\p{M} ’'\-]{2,50}$/u.test(value.trim());
const emailOk = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

function readSession<T>(key: string): T | null {
  try {
    const value = sessionStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : null;
  } catch {
    return null;
  }
}
function writeSession(key: string, value: unknown) {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Navegación privada o almacenamiento bloqueado: el flujo sigue sin recordar el borrador.
  }
}

/**
 * Agenda por pasos: Fecha y hora → Tu solicitud → Contacto → Confirmar.
 * Cliente → Instafix → Cal.com API. Con sesión, los datos de contacto salen de la cuenta.
 */
export function BookingFlow({ user }: { user: AccountUser | null }) {
  const draft = useRef(readSession<{ request: string; day: string | null }>(DRAFT_KEY));
  const [step, setStep] = useState<Step>('schedule');
  const [day, setDay] = useState<string | null>(() => draft.current?.day ?? null);
  const [slot, setSlot] = useState<BookingSlot | null>(null);
  const [takenSlot, setTakenSlot] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [request, setRequest] = useState(() => draft.current?.request || '');
  const [guest, setGuest] = useState<Guest>({ firstName: '', lastName: '', phone: '', email: '' });
  const [country, setCountry] = useState<CountryCode>('EC');
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BookingResult | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => writeSession(DRAFT_KEY, null), []);
  const shownStep = useRef(step);
  useEffect(() => {
    // Al cambiar de paso, el foco va al título (lectores de pantalla) y se mantiene a la vista.
    if (shownStep.current === step) return;
    shownStep.current = step;
    heading.current?.focus({ preventScroll: true });
    heading.current
      ?.closest('.booking-flow')
      ?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [step]);

  const fetchAvailability = useCallback<FetchAvailability>(async (start, end) => {
    const data = await api<{ days: Record<string, string[]> }>(
      `booking/slots?from=${start}&to=${end}`,
    ).catch((e: unknown) => {
      throw new Error(
        e instanceof ApiError && e.status === 503
          ? 'La agenda no responde en este momento. Inténtalo de nuevo en unos minutos.'
          : 'No pudimos consultar los horarios. Revisa tu conexión.',
      );
    });
    return Object.fromEntries(
      Object.entries(data.days).map(([key, starts]) => [key, starts.map((s) => ({ start: s }))]),
    );
  }, []);

  const go = (next: Step) => {
    setError('');
    setStep(next);
  };
  const guestPhone = () => normalizePhone(guest.phone, country);

  function submitRequest(event: FormEvent) {
    event.preventDefault();
    if (request.trim().length < 10) {
      setError('Cuéntanos un poco más sobre lo que necesitas (mínimo 10 caracteres).');
      return;
    }
    go(user ? 'review' : 'contact');
  }

  function submitContact(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const raw = String(new FormData(event.currentTarget).get('phone') ?? '');
    const phone = normalizePhone(raw, country);
    setGuest((g) => ({ ...g, phone: raw }));
    if (!nameOk(guest.firstName) || !nameOk(guest.lastName)) {
      setError('Escribe tu nombre y apellido usando letras.');
      return;
    }
    if (!phone) {
      setError('Revisa tu número de WhatsApp y el país seleccionado.');
      return;
    }
    if (!emailOk(guest.email)) {
      setError('Escribe un correo válido para enviarte la confirmación.');
      return;
    }
    go('review');
  }

  function goToLogin() {
    writeSession(DRAFT_KEY, { request, day });
    window.location.hash = '#cuenta';
  }

  async function confirm() {
    if (busy || !slot) return;
    if (!consent) {
      setError('Autoriza el contacto por WhatsApp para coordinar la visita.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const created = await api<BookingResult>('booking', {
        method: 'POST',
        body: JSON.stringify({
          start: slot.start,
          request: request.trim(),
          whatsappConsent: true,
          // Con sesión iniciada no se envían datos de contacto: el servidor usa la cuenta.
          ...(user
            ? {}
            : {
                name: `${guest.firstName.trim()} ${guest.lastName.trim()}`,
                phone: guestPhone(),
                email: guest.email.trim(),
              }),
        }),
      });
      setResult(created);
      go('done');
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        // El horario se ocupó mientras confirmabas: vuelve a elegir con datos frescos.
        setTakenSlot(slot.start);
        setSlot(null);
        setRefreshKey((n) => n + 1);
        setStep('schedule');
        return;
      }
      setError(e instanceof Error ? e.message : 'No pudimos crear la cita.');
    } finally {
      setBusy(false);
    }
  }

  const currentIndex = steps.findIndex((s) => s.id === step);
  const header = (title: string, eyebrow: string) => (
    <>
      <p className="eyebrow">{eyebrow}</p>
      <h3 ref={heading} tabIndex={-1} className="booking-step-title">
        {title}
      </h3>
    </>
  );
  const errorBox = error && (
    <div className="booking-error" role="alert">
      <p>{error}</p>
    </div>
  );

  if (step === 'done' && result) {
    return (
      <div className="booking-flow booking-done">
        <div className="done-mark" aria-hidden="true">
          ✓
        </div>
        {header(
          result.status === 'CONFIRMED' ? 'Tu cita está confirmada' : 'Cita agendada',
          'TODO LISTO',
        )}
        <p className="done-when">
          {formatDay(dayKey(result.startsAt))}
          <strong>{formatTime(result.startsAt)}</strong>
        </p>
        <p className="done-status">
          {result.status === 'CONFIRMED'
            ? 'Tu visita está confirmada. Tu técnico se pondrá en contacto contigo antes de llegar.'
            : 'Recibimos tu solicitud. Te escribiremos por WhatsApp para confirmar la visita y tu ubicación.'}
        </p>
        {result.email.maskedEmail && result.email.status !== 'NONE' && (
          <p className="done-status">
            {result.email.status === 'SENT'
              ? `Te enviamos la confirmación a ${result.email.maskedEmail}.`
              : `Estamos enviando la confirmación a ${result.email.maskedEmail}.`}
          </p>
        )}
        {result.account === 'GUEST' ? (
          <div className="done-invite">
            <h4>Crea tu cuenta de InstaFix</h4>
            <p>
              Consulta tus citas, gestiona futuras reservas y mantén tu información guardada. Usa el
              mismo número de WhatsApp: al verificarlo, esta cita aparecerá en tu cuenta.
            </p>
            <a className="button" href="#cuenta">
              Crear mi cuenta <span>→</span>
            </a>
          </div>
        ) : (
          <>
            <p>Puedes consultar esta cita desde Mi cuenta.</p>
            <a className="button" href="#cuenta">
              Ver en Mis citas <span>→</span>
            </a>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="booking-flow">
      <ol className="booking-progress" aria-label="Pasos para agendar">
        {steps
          .filter((s) => !(user && s.id === 'contact'))
          .map((s, index) => {
            const realIndex = steps.findIndex((x) => x.id === s.id);
            const state =
              realIndex < currentIndex ? 'done' : realIndex === currentIndex ? 'current' : 'next';
            return (
              <li
                key={s.id}
                className={'is-' + state}
                aria-current={state === 'current' ? 'step' : undefined}
              >
                <span>{index + 1}</span>
                <b>{s.label}</b>
              </li>
            );
          })}
      </ol>

      {step === 'schedule' && (
        <section className="booking-step">
          {header('Elige el día y la hora', 'PASO 1')}
          <ScheduleStep
            fetchAvailability={fetchAvailability}
            selectedDay={day}
            selectedSlot={slot}
            onDayChange={setDay}
            onSlotChange={(next) => {
              setSlot(next);
              if (next) setTakenSlot(null);
            }}
            takenSlot={takenSlot}
            refreshKey={refreshKey}
          />
          <div className="booking-actions is-end">
            <button type="button" className="button" disabled={!slot} onClick={() => go('request')}>
              Continuar <span>→</span>
            </button>
          </div>
        </section>
      )}

      {step === 'request' && (
        <form className="booking-step" onSubmit={submitRequest} noValidate>
          {header('¿Qué necesitas o qué le pasa a tu equipo?', 'PASO 2')}
          <label>
            Describe lo que notas
            <textarea
              value={request}
              maxLength={500}
              rows={5}
              placeholder="Ej.: Mi PS5 se apaga después de jugar unos minutos."
              onChange={(e) => setRequest(e.target.value)}
              aria-describedby="request-help"
            />
          </label>
          <p id="request-help" className="step-help">
            No tienes que elegir un servicio. El técnico revisará tu equipo y te explicará el
            trabajo adecuado antes de empezar. {request.trim().length}/500
          </p>
          {errorBox}
          <div className="booking-actions">
            <button type="button" className="text-button" onClick={() => go('schedule')}>
              ← Fecha y hora
            </button>
            <button className="button">
              Continuar <span>→</span>
            </button>
          </div>
        </form>
      )}

      {step === 'contact' && !user && (
        <form className="booking-step" onSubmit={submitContact} noValidate>
          {header('¿Cómo te contactamos?', 'PASO 3')}
          <p className="step-help">
            ¿Ya tienes cuenta?{' '}
            <button type="button" className="text-button" onClick={goToLogin}>
              Inicia sesión
            </button>{' '}
            y usaremos tus datos verificados.
          </p>
          <div className="form-row">
            <label>
              Nombre
              <input
                autoComplete="given-name"
                value={guest.firstName}
                maxLength={50}
                onChange={(e) => setGuest({ ...guest, firstName: e.target.value })}
              />
            </label>
            <label>
              Apellido
              <input
                autoComplete="family-name"
                value={guest.lastName}
                maxLength={50}
                onChange={(e) => setGuest({ ...guest, lastName: e.target.value })}
              />
            </label>
          </div>
          <PhoneField
            id="booking-phone"
            country={country}
            onCountry={setCountry}
            defaultValue={guest.phone}
          />
          <label>
            Correo electrónico
            <input
              type="email"
              autoComplete="email"
              inputMode="email"
              value={guest.email}
              maxLength={254}
              onChange={(e) => setGuest({ ...guest, email: e.target.value })}
            />
          </label>
          <p className="step-help">Te enviaremos la confirmación de la cita a este correo.</p>
          {errorBox}
          <div className="booking-actions">
            <button type="button" className="text-button" onClick={() => go('request')}>
              ← Tu solicitud
            </button>
            <button className="button">
              Revisar cita <span>→</span>
            </button>
          </div>
        </form>
      )}

      {step === 'review' && slot && (
        <section className="booking-step">
          {header('Tu cita', 'REVISA Y CONFIRMA')}
          <dl className="booking-summary">
            <div>
              <dt>Fecha</dt>
              <dd>{formatDay(dayKey(slot.start))}</dd>
            </div>
            <div>
              <dt>Hora estimada</dt>
              <dd>{formatTime(slot.start)}</dd>
            </div>
            <div className="summary-wide">
              <dt>Solicitud</dt>
              <dd>“{request.trim()}”</dd>
            </div>
            <div className="summary-wide">
              <dt>Datos de contacto</dt>
              <dd>
                {user ? user.name : `${guest.firstName.trim()} ${guest.lastName.trim()}`}
                <span className="summary-phone">
                  {user ? (
                    <>
                      {maskPhone(user.phone)}{' '}
                      <span aria-label="Número verificado de tu cuenta, no editable">🔒</span>
                    </>
                  ) : (
                    guestPhone()
                  )}
                </span>
                {(user ? user.email : guest.email) && (
                  <span>{user ? user.email : guest.email}</span>
                )}
              </dd>
            </div>
          </dl>
          {user && (
            <p className="step-help">
              Usamos el WhatsApp verificado de tu cuenta. Puedes cambiarlo en Mi cuenta → Seguridad.
            </p>
          )}
          <label className="check">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
            />
            Autorizo a InstaFix a escribirme por WhatsApp para confirmar y coordinar esta visita.
          </label>
          {errorBox}
          <div className="booking-actions">
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={() => go(user ? 'request' : 'contact')}
            >
              ← Modificar
            </button>
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={confirm}
              aria-busy={busy}
            >
              {busy ? 'Agendando…' : 'Confirmar cita'}
              <span>{busy ? '' : '→'}</span>
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
