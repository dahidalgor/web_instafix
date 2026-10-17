import {
  customerRequestSchema,
  guestContactSchema,
  type BookingConfig,
  type BookingResult,
  type BookingSlot,
} from '@instafix/contracts';
import {
  getCountries,
  getCountryCallingCode,
  normalizePhone,
  type CountryCode,
} from '@instafix/contracts/src/phone';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError } from '../../lib/api';
import { dayKey, formatDay, formatTime, newRequestKey } from './booking-time';
import { ScheduleStep, type FetchAvailability } from './ScheduleStep';

const names = new Intl.DisplayNames(['es'], { type: 'region' });
const countries = getCountries().sort((a, b) =>
  (names.of(a) ?? a).localeCompare(names.of(b) ?? b, 'es'),
);
const DRAFT_KEY = 'instafix:booking-draft';

type Step = 'schedule' | 'request' | 'contact' | 'review' | 'done';
const steps: { id: Exclude<Step, 'done'>; label: string }[] = [
  { id: 'schedule', label: 'Fecha y hora' },
  { id: 'request', label: 'Tu solicitud' },
  { id: 'contact', label: 'Contacto' },
  { id: 'review', label: 'Confirmar' },
];

type Guest = {
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  country: CountryCode;
};

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

export function BookingFlow({ config }: { config: BookingConfig }) {
  const draft = useRef(readSession<{ request: string; day: string | null }>(DRAFT_KEY));
  const user = config.user;
  const [step, setStep] = useState<Step>('schedule');
  const [day, setDay] = useState<string | null>(() => draft.current?.day ?? null);
  const [slot, setSlot] = useState<BookingSlot | null>(null);
  const [takenSlot, setTakenSlot] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [request, setRequest] = useState(() => draft.current?.request || '');
  const [guest, setGuest] = useState<Guest>({
    firstName: '',
    lastName: '',
    phone: '',
    email: '',
    country: 'EC',
  });
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState('');
  const [errorCode, setErrorCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BookingResult | null>(null);
  // Una clave por intento: reintentar tras un fallo de red no puede crear dos citas.
  const requestKey = useRef<string | null>(null);
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
    const data = await api<{ days: Record<string, BookingSlot[]> }>(
      `booking/availability?start=${start}&end=${end}`,
    ).catch((e: unknown) => {
      throw new Error(
        e instanceof ApiError && e.status === 503
          ? 'La agenda no responde en este momento. Inténtalo de nuevo en unos minutos.'
          : 'No pudimos consultar los horarios. Revisa tu conexión.',
      );
    });
    return data.days;
  }, []);

  const go = (next: Step) => {
    setError('');
    setErrorCode('');
    setStep(next);
  };

  // Cualquier cambio de horario o contacto invalida la clave del intento anterior.
  useEffect(() => {
    requestKey.current = null;
  }, [slot?.start, guest.phone, guest.email, guest.firstName, guest.lastName, request]);

  function chooseSlot(next: BookingSlot | null) {
    setSlot(next);
    if (next) setTakenSlot(null);
  }

  function submitRequest(event: FormEvent) {
    event.preventDefault();
    const parsed = customerRequestSchema.safeParse(request);
    if (!parsed.success) {
      setError(parsed.error.issues[0].message);
      return;
    }
    go(user ? 'review' : 'contact');
  }

  function submitContact(event: FormEvent) {
    event.preventDefault();
    const phone = normalizePhone(guest.phone, guest.country);
    if (!phone) {
      setError('Revisa tu número de WhatsApp y el país seleccionado.');
      return;
    }
    const parsed = guestContactSchema.safeParse({ ...guest, phone });
    if (!parsed.success) {
      setError(parsed.error.issues[0].message);
      return;
    }
    go('review');
  }

  function goToLogin() {
    writeSession(DRAFT_KEY, { request, day });
    writeSession('instafix:return-to', '#agenda');
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
    setErrorCode('');
    requestKey.current ??= newRequestKey();
    try {
      const phone = user ? undefined : normalizePhone(guest.phone, guest.country);
      const created = await api<BookingResult>('booking/appointments', {
        method: 'POST',
        body: JSON.stringify({
          requestKey: requestKey.current,
          start: slot.start,
          customerRequest: request.trim(),
          whatsappConsent: true,
          // Con sesión iniciada no se envían datos de contacto: el servidor usa la cuenta.
          ...(user
            ? {}
            : {
                guest: {
                  firstName: guest.firstName.trim(),
                  lastName: guest.lastName.trim(),
                  phone,
                  email: guest.email.trim(),
                },
              }),
        }),
      });
      setResult(created);
      if (created.guest)
        writeSession('instafix:register-prefill', {
          firstName: guest.firstName.trim(),
          lastName: guest.lastName.trim(),
          email: guest.email.trim(),
          phone,
        });
      go('done');
    } catch (e) {
      const code = e instanceof ApiError ? (e.code ?? '') : '';
      const message = e instanceof Error ? e.message : 'No pudimos crear la cita.';
      if (code === 'SLOT_TAKEN') {
        setTakenSlot(slot.start);
        setSlot(null);
        setRefreshKey((n) => n + 1);
        requestKey.current = null;
        setStep('schedule');
        return;
      }
      // Errores definitivos: el siguiente intento usa otra clave.
      if (!['UNCERTAIN', 'IN_PROGRESS', ''].includes(code)) requestKey.current = null;
      setErrorCode(code);
      setError(message);
      if (code === 'ACCOUNT_EXISTS' || code === 'INVALID_EMAIL') setStep('contact');
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
      {errorCode === 'ACCOUNT_EXISTS' && (
        <button type="button" className="button" onClick={goToLogin}>
          Iniciar sesión <span>→</span>
        </button>
      )}
    </div>
  );

  if (step === 'done' && result) {
    const appointment = result.appointment;
    return (
      <div className="booking-flow booking-done">
        <div className="done-mark" aria-hidden="true">
          ✓
        </div>
        {header('Cita agendada', 'TODO LISTO')}
        <p className="done-when">
          {formatDay(dayKey(appointment.startsAt))}
          <strong>{formatTime(appointment.startsAt)}</strong>
        </p>
        <p className="done-status">
          {appointment.status === 'CONFIRMED'
            ? 'Tu visita está confirmada. Te escribiremos por WhatsApp para coordinar la ubicación.'
            : 'Recibimos tu solicitud. Te escribiremos por WhatsApp para confirmar la visita y tu ubicación.'}
        </p>
        {result.guest ? (
          <div className="done-invite">
            <h4>Crea tu cuenta de InstaFix</h4>
            <p>
              Consulta tus citas, gestiona futuras reservas y mantén tu información guardada. Usa el
              mismo número de WhatsApp.
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
            onSlotChange={chooseSlot}
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
              maxLength={1000}
              rows={5}
              placeholder="Ej.: Mi PS5 se apaga después de jugar unos minutos."
              onChange={(e) => setRequest(e.target.value)}
              aria-describedby="request-help"
            />
          </label>
          <p id="request-help" className="step-help">
            No tienes que elegir un servicio. El técnico revisará tu equipo y te explicará el
            trabajo adecuado antes de empezar. {request.trim().length}/1000
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
            y usaremos tus datos guardados.
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
          <div className="phone-fields">
            <label>
              País
              <select
                value={guest.country}
                onChange={(e) => setGuest({ ...guest, country: e.target.value as CountryCode })}
              >
                {countries.map((code) => (
                  <option key={code} value={code}>
                    {names.of(code)} (+{getCountryCallingCode(code)})
                  </option>
                ))}
              </select>
            </label>
            <label>
              WhatsApp
              <input
                type="tel"
                inputMode="tel"
                autoComplete="tel-national"
                placeholder="098 470 3819"
                value={guest.phone}
                maxLength={30}
                onChange={(e) => setGuest({ ...guest, phone: e.target.value })}
              />
            </label>
          </div>
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
              <dt>Hora</dt>
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
                      {user.maskedPhone}{' '}
                      <span aria-label="Número de tu cuenta, no editable">🔒</span>
                    </>
                  ) : (
                    normalizePhone(guest.phone, guest.country)
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
              Usamos el WhatsApp registrado en tu cuenta. Para cambiarlo, contáctanos.
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
              {busy
                ? 'Agendando…'
                : errorCode === 'UNCERTAIN'
                  ? 'Volver a intentar'
                  : 'Confirmar cita'}
              <span>{busy ? '' : '→'}</span>
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
