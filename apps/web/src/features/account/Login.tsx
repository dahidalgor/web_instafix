import type { AccountUser } from '@instafix/contracts';
import {
  getCountries,
  getCountryCallingCode,
  normalizePhone,
  type CountryCode,
} from '@instafix/contracts/src/phone';
import { useState, type FormEvent } from 'react';
import { api } from '../../lib/api';

const countryNames = new Intl.DisplayNames(['es'], { type: 'region' });
const countries = getCountries().sort((a, b) =>
  (countryNames.of(a) ?? a).localeCompare(countryNames.of(b) ?? b, 'es'),
);
export function Login({
  admin = false,
  onLogin,
}: {
  admin?: boolean;
  onLogin: (user: AccountUser) => void;
}) {
  const [register, setRegister] = useState(false);
  const [country, setCountry] = useState<CountryCode>('EC');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    const form = new FormData(event.currentTarget);
    // El formato internacional unifica el acceso y el registro, incluso con el cero nacional.
    const phone = normalizePhone(String(form.get('phone') ?? ''), country);
    if (!phone) return setError('Revisa tu número y el país seleccionado.');
    setBusy(true);
    try {
      const user = await api(`auth/${register ? 'register' : 'login'}`, {
        method: 'POST',
        body: JSON.stringify({
          phone,
          password: form.get('password'),
          ...(register ? { name: form.get('name') } : {}),
        }),
      });
      onLogin(user);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="account-panel account-login">
      <div className="account-login-card">
        <div className="account-login-mark" aria-hidden="true">
          <span>i</span>
        </div>
        <p className="eyebrow">{admin ? 'ACCESO RESTRINGIDO' : 'TU ESPACIO INSTAFIX'}</p>
        <h1>{register ? 'Crea tu cuenta' : 'Iniciar sesión'}</h1>
        <p className="account-login-intro">
          {admin
            ? 'Solo personal autorizado de Instafix.'
            : 'Consulta tus servicios anteriores y sus garantías.'}
        </p>
        <form onSubmit={submit}>
          {register && (
            <label>
              Nombre
              <input name="name" autoComplete="name" required minLength={2} maxLength={100} />
            </label>
          )}
          <div className="phone-fields">
            <label>
              País y código
              <select
                name="country"
                autoComplete="tel-country-code"
                value={country}
                onChange={(event) => setCountry(event.target.value as CountryCode)}
              >
                {countries.map((code) => (
                  <option key={code} value={code}>
                    {countryNames.of(code)} (+{getCountryCallingCode(code)})
                  </option>
                ))}
              </select>
            </label>
            <label>
              Número de teléfono
              <input
                name="phone"
                type="tel"
                placeholder={country === 'EC' ? '984703819' : 'Tu número de teléfono'}
                autoComplete="username"
                aria-describedby="login-phone-hint"
                maxLength={30}
                required
              />
            </label>
          </div>
          <label>
            Contraseña
            <input
              name="password"
              type="password"
              minLength={12}
              maxLength={128}
              autoComplete={register ? 'new-password' : 'current-password'}
              required
            />
          </label>
          {register && (
            <p className="small">
              Usa al menos 12 caracteres. Los trabajos previos se vinculan después de comprobar tu
              identidad.
            </p>
          )}
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <button className="button" disabled={busy}>
            {busy ? 'Procesando…' : register ? 'Crear cuenta' : 'Entrar'}
          </button>
        </form>
      </div>
      {!admin && (
        <p className="account-login-switch">
          {register ? '¿Ya tienes una cuenta?' : '¿Aún no tienes una cuenta?'}{' '}
          <button
            className="text-button"
            onClick={() => {
              setRegister(!register);
              setError('');
            }}
          >
            {register ? 'Iniciar sesión' : 'Crear una cuenta'}
          </button>
        </p>
      )}
    </section>
  );
}
