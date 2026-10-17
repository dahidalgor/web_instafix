import type { AccountUser } from '@instafix/contracts';
import {
  getCountries,
  getCountryCallingCode,
  normalizePhone,
  type CountryCode,
} from '@instafix/contracts/src/phone';
import { useState, type FormEvent } from 'react';
import { api } from '../../lib/api';

const names = new Intl.DisplayNames(['es'], { type: 'region' });
const countries = getCountries().sort((a, b) =>
  (names.of(a) ?? a).localeCompare(names.of(b) ?? b, 'es'),
);
const flag = (country: string) =>
  [...country].map((letter) => String.fromCodePoint(127397 + letter.charCodeAt(0))).join('');
type Mode = 'login' | 'register' | 'forgot' | 'verify' | 'reset';

export function Login({
  admin = false,
  onLogin,
}: {
  admin?: boolean;
  onLogin: (user: AccountUser) => void;
}) {
  const [mode, setMode] = useState<Mode>('login');
  const [country, setCountry] = useState<CountryCode>('EC');
  const [challengeId, setChallengeId] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [resendAfter, setResendAfter] = useState(0);
  const changeMode = (next: Mode) => {
    setMode(next);
    setError('');
    setNotice('');
  };
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setNotice('');
    const data = new FormData(event.currentTarget);
    setBusy(true);
    try {
      if (mode === 'login' || mode === 'register') {
        const phone = normalizePhone(String(data.get('phone') ?? ''), country);
        if (!phone) throw new Error('Revisa tu número y el país seleccionado.');
        const payload = {
          phone,
          password: data.get('password'),
          ...(mode === 'register'
            ? { firstName: data.get('firstName'), lastName: data.get('lastName'), email }
            : {}),
        };
        if (mode === 'login')
          onLogin(
            await api<AccountUser>('auth/login', { method: 'POST', body: JSON.stringify(payload) }),
          );
        else {
          const result = await api<{ challengeId: string }>('auth/register', {
            method: 'POST',
            body: JSON.stringify(payload),
          });
          setChallengeId(result.challengeId);
          setMode('verify');
          setResendAfter(Date.now() + 60000);
        }
      } else if (mode === 'forgot') {
        const result = await api<{ challengeId: string }>('auth/forgot-password', {
          method: 'POST',
          body: JSON.stringify({ email }),
        });
        setChallengeId(result.challengeId);
        setMode('reset');
        setResendAfter(Date.now() + 60000);
      } else if (mode === 'verify') {
        onLogin(
          await api<AccountUser>('auth/verify-email', {
            method: 'POST',
            body: JSON.stringify({ challengeId, code: data.get('code') }),
          }),
        );
      } else {
        if (data.get('password') !== data.get('confirmPassword'))
          throw new Error('Las contraseñas no coinciden.');
        await api('auth/reset-password', {
          method: 'POST',
          body: JSON.stringify({
            challengeId,
            code: data.get('code'),
            password: data.get('password'),
          }),
        });
        setMode('login');
        setNotice('Contraseña actualizada. Ya puedes iniciar sesión.');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo completar la solicitud.');
    } finally {
      setBusy(false);
    }
  }
  async function resend() {
    setError('');
    setNotice('');
    if (Date.now() < resendAfter) {
      setError('Espera un minuto entre envíos.');
      return;
    }
    setBusy(true);
    try {
      const result = await api<{ challengeId: string }>('auth/resend-code', {
        method: 'POST',
        body: JSON.stringify({ challengeId }),
      });
      setChallengeId(result.challengeId);
      setResendAfter(Date.now() + 60000);
      setNotice('Si el correo corresponde a la solicitud, recibirás un nuevo código.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo reenviar.');
    } finally {
      setBusy(false);
    }
  }
  const titles = {
    login: 'Iniciar sesión',
    register: 'Crea tu cuenta',
    forgot: 'Recupera tu acceso',
    verify: 'Verifica tu correo',
    reset: 'Nueva contraseña',
  };
  const labels = {
    login: 'Entrar',
    register: 'Crear cuenta',
    forgot: 'Enviar código',
    verify: 'Verificar cuenta',
    reset: 'Guardar contraseña',
  };
  return (
    <section className="account-panel account-login">
      <div className="account-login-card">
        <p className="eyebrow">{admin ? 'ACCESO RESTRINGIDO' : 'TU ESPACIO INSTAFIX'}</p>
        <h1>{titles[mode]}</h1>
        <p className="account-login-intro">
          {mode === 'verify'
            ? `Enviamos un código a ${email}. Caduca en 10 minutos.`
            : mode === 'reset'
              ? 'Si el correo está verificado en una cuenta, recibirás un código válido durante 10 minutos. Revisa también spam.'
              : mode === 'forgot'
                ? 'Usa el correo verificado de tu cuenta para recibir un código.'
                : 'Tus citas, servicios y garantías en un solo lugar.'}
        </p>
        <form key={mode} onSubmit={submit}>
          {mode === 'register' && (
            <div className="form-row">
              <label>
                Nombre
                <input
                  name="firstName"
                  autoComplete="given-name"
                  required
                  minLength={2}
                  maxLength={50}
                />
              </label>
              <label>
                Apellido
                <input
                  name="lastName"
                  autoComplete="family-name"
                  required
                  minLength={2}
                  maxLength={50}
                />
              </label>
            </div>
          )}
          {(mode === 'register' || mode === 'forgot') && (
            <label>
              Correo electrónico
              <input
                name="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                maxLength={254}
                placeholder="nombre@correo.com"
              />
            </label>
          )}
          {(mode === 'login' || mode === 'register') && (
            <div className="auth-phone-field">
              <label htmlFor="auth-phone">Número de teléfono</label>
              <div className="auth-phone-control">
                <div className="auth-country">
                  <span aria-hidden="true">
                    {flag(country)} +{getCountryCallingCode(country)}{' '}
                    <span className="auth-country-chevron">⌄</span>
                  </span>
                  <select
                    name="country"
                    aria-label="País y código"
                    value={country}
                    onChange={(e) => setCountry(e.target.value as CountryCode)}
                    autoComplete="tel-country-code"
                  >
                    {countries.map((code) => (
                      <option key={code} value={code}>
                        {flag(code)} {names.of(code)} (+{getCountryCallingCode(code)})
                      </option>
                    ))}
                  </select>
                </div>
                <input
                  id="auth-phone"
                  name="phone"
                  type="tel"
                  autoComplete="username"
                  placeholder="987654321"
                  required
                  maxLength={30}
                />
              </div>
            </div>
          )}
          {(mode === 'verify' || mode === 'reset') && (
            <label>
              Código de verificación
              <input
                className="auth-code"
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                minLength={6}
                maxLength={6}
                required
                placeholder="000000"
              />
            </label>
          )}
          {(mode === 'login' || mode === 'register' || mode === 'reset') && (
            <label>
              {mode === 'reset' ? 'Nueva contraseña' : 'Contraseña'}
              <input
                name="password"
                type="password"
                minLength={12}
                maxLength={128}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                required
              />
            </label>
          )}
          {mode === 'reset' && (
            <label>
              Repite la contraseña
              <input
                name="confirmPassword"
                type="password"
                autoComplete="new-password"
                required
                minLength={12}
                maxLength={128}
              />
            </label>
          )}
          {(mode === 'register' || mode === 'reset') && (
            <p className="small">Usa al menos 12 caracteres para tu contraseña.</p>
          )}
          {mode === 'login' && (
            <button type="button" className="auth-link" onClick={() => changeMode('forgot')}>
              ¿Olvidaste tu contraseña?
            </button>
          )}
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          {notice && (
            <p role="status" className="small">
              {notice}
            </p>
          )}
          <div className="auth-actions">
            <button className="button" disabled={busy}>
              {busy ? 'Procesando…' : labels[mode]}
            </button>
          </div>
          {(mode === 'verify' || mode === 'reset') && (
            <button className="auth-link" type="button" disabled={busy} onClick={resend}>
              Reenviar código
            </button>
          )}
        </form>
      </div>
      <p className="account-login-switch">
        {mode === 'login' ? (
          !admin && (
            <>
              <span>¿Aún no tienes cuenta? </span>
              <button className="auth-link" onClick={() => changeMode('register')}>
                Crear una cuenta
              </button>
            </>
          )
        ) : (
          <button className="auth-link" disabled={busy} onClick={() => changeMode('login')}>
            Volver a iniciar sesión
          </button>
        )}
      </p>
    </section>
  );
}
