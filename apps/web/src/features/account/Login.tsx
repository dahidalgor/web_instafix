import { PasswordInput } from '../../components/ui/PasswordInput';
import type { AccountUser, VerificationTicket } from '@instafix/contracts';
import { type CountryCode, normalizePhone, splitPhone } from '@instafix/contracts/src/phone';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { BusyButton } from '../../components/ui/BusyButton';
import { api, ApiError } from '../../lib/api';
import { PhoneField } from './PhoneField';
import { PhoneVerification } from './PhoneVerification';
import { clearRegisterPrefill, takeRegisterPrefill } from './register-prefill';

type Mode = 'login' | 'register' | 'verify' | 'forgot-email' | 'email-sent' | 'new-password';

export function Login({
  admin = false,
  onLogin,
  resetToken: initialResetToken,
}: {
  admin?: boolean;
  onLogin: (user: AccountUser) => void;
  /** Token recibido en el enlace de recuperación por correo. */
  resetToken?: string;
}) {
  // Viene de «Crear mi cuenta» tras reservar como invitado: datos de la reserva ya escritos.
  const [prefill] = useState(() => (admin || initialResetToken ? null : takeRegisterPrefill()));
  const [mode, setMode] = useState<Mode>(
    initialResetToken
      ? 'new-password'
      : prefill || (!admin && window.location.hash === '#registro')
        ? 'register'
        : 'login',
  );
  // «Registrarse» del menú de usuario cuando ya se está en Mi cuenta.
  useEffect(() => {
    if (admin) return;
    const follow = () => {
      if (window.location.hash === '#registro') changeMode('register');
    };
    window.addEventListener('hashchange', follow);
    return () => window.removeEventListener('hashchange', follow);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [admin]);
  const prefillPhone = prefill ? splitPhone(prefill.phone) : null;
  const [country, setCountry] = useState<CountryCode>(prefillPhone?.country ?? 'EC');
  const [ticket, setTicket] = useState<VerificationTicket | null>(null);
  const [credentials, setCredentials] = useState<{ phone: string; password: string } | null>(null);
  const [resetToken, setResetToken] = useState(initialResetToken || '');
  const [email, setEmail] = useState(prefill?.email ?? '');
  const [error, setError] = useState<ReactNode>('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  // Segundos hasta poder pedir otro código (límite de 60 s por número).
  const [wait, setWait] = useState(0);
  useEffect(() => {
    if (wait <= 0) return;
    const timer = window.setTimeout(() => setWait((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [wait]);
  const changeMode = (next: Mode) => {
    // Así «Registrarse» del menú vuelve a funcionar después de cambiar de pantalla.
    if (next !== 'register' && window.location.hash === '#registro')
      history.replaceState(null, '', '#cuenta');
    setMode(next);
    setError('');
    setNotice('');
  };
  const phoneFrom = (data: FormData) => {
    // Ayuda inmediata en el navegador; el backend vuelve a normalizar y decide.
    const raw = String(data.get('phone') ?? '');
    return normalizePhone(raw, country) ?? raw;
  };
  const toVerification = (next: VerificationTicket | null, message = '') => {
    setTicket(next);
    setMode('verify');
    setError('');
    setNotice(message);
  };

  async function login(phone: string, password: string) {
    try {
      onLogin(
        await api<AccountUser>('auth/login', {
          method: 'POST',
          body: JSON.stringify({ phone, password }),
        }),
      );
      return null;
    } catch (e) {
      if (e instanceof ApiError && e.code === 'PHONE_UNVERIFIED') {
        setCredentials({ phone, password });
        return {
          verification: (e.body?.verification ?? null) as VerificationTicket | null,
          deliveryError: (e.body?.deliveryError ?? '') as string,
        };
      }
      throw e;
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setNotice('');
    const data = new FormData(event.currentTarget);
    setBusy(true);
    try {
      if (mode === 'login') {
        const pending = await login(phoneFrom(data), String(data.get('password') ?? ''));
        if (pending)
          toVerification(
            pending.verification,
            pending.deliveryError || 'Verifica tu WhatsApp para continuar.',
          );
      } else if (mode === 'register') {
        const payload = {
          firstName: data.get('firstName'),
          lastName: data.get('lastName'),
          email,
          phone: phoneFrom(data),
          password: data.get('password'),
        };
        try {
          toVerification(
            await api<VerificationTicket>('auth/register', {
              method: 'POST',
              body: JSON.stringify(payload),
            }),
          );
          clearRegisterPrefill();
        } catch (e) {
          if (e instanceof ApiError && e.code === 'PHONE_IN_USE') {
            clearRegisterPrefill();
            setError(
              <>
                Este número ya está asociado a una cuenta. Inicia sesión para continuar.{' '}
                <button type="button" className="auth-link" onClick={() => changeMode('login')}>
                  Iniciar sesión
                </button>{' '}
                ·{' '}
                <button
                  type="button"
                  className="auth-link"
                  onClick={() => changeMode('forgot-email')}
                >
                  Recuperar contraseña
                </button>
              </>,
            );
            return;
          }
          throw e;
        }
      } else if (mode === 'forgot-email') {
        const result = await api<{ message: string }>('auth/password-reset/email', {
          method: 'POST',
          body: JSON.stringify({ email }),
        });
        setMode('email-sent');
        setNotice(result.message);
      } else if (mode === 'new-password') {
        if (data.get('password') !== data.get('confirmPassword'))
          throw new Error('Las contraseñas no coinciden.');
        await api('auth/password-reset/complete', {
          method: 'POST',
          body: JSON.stringify({ token: resetToken, password: data.get('password') }),
        });
        if (window.location.hash.startsWith('#restablecer'))
          history.replaceState(null, '', '#cuenta');
        setResetToken('');
        setMode('login');
        setNotice('Contraseña actualizada. Ya puedes iniciar sesión.');
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === 'OTP_RATE_LIMIT') {
        setWait(Number(e.body?.retryAfter) || 60);
        setError(
          'Ya pediste un código para este número hace muy poco. Si tu WhatsApp está verificado, revisa tus mensajes; si no, podrás pedir otro cuando termine la cuenta atrás.',
        );
        return;
      }
      setError(e instanceof Error ? e.message : 'No se pudo completar la solicitud.');
    } finally {
      setBusy(false);
    }
  }

  const titles: Partial<Record<Mode, string>> = {
    login: 'Iniciar sesión',
    register: 'Crea tu cuenta',
    'forgot-email': 'Recupera tu acceso',
    'email-sent': 'Revisa tu correo',
    'new-password': 'Nueva contraseña',
  };
  const intros: Partial<Record<Mode, string>> = {
    login: 'Tus citas, servicios y garantías en un solo lugar.',
    register: 'Verificaremos tu número por WhatsApp para activar tu cuenta.',
    'forgot-email':
      'Escribe el correo verificado de tu cuenta y te enviaremos un enlace para elegir una contraseña nueva.',
    'new-password': 'Elige una contraseña nueva de al menos 12 caracteres.',
  };
  const labels: Partial<Record<Mode, string>> = {
    login: 'Entrar',
    register: 'Crear cuenta',
    'forgot-email': 'Enviar enlace',
    'new-password': 'Guardar contraseña',
  };
  const form = !['verify', 'email-sent'].includes(mode);

  return (
    <section className="account-panel account-login">
      <div className="account-login-card">
        <p className="eyebrow">{admin ? 'ACCESO RESTRINGIDO' : 'TU ESPACIO INSTAFIX'}</p>
        {mode === 'verify' && (
          <>
            {notice && (
              <p role="status" className="small otp-notice">
                {notice}
              </p>
            )}
            <PhoneVerification<AccountUser>
              key={ticket?.verificationId ?? 'pending'}
              ticket={ticket}
              verifyPath="auth/phone/verify"
              resendPath="auth/phone/resend"
              onVerified={onLogin}
              onResendWithoutTicket={async () => {
                if (!credentials) return null;
                const pending = await login(credentials.phone, credentials.password);
                if (pending?.deliveryError) throw new Error(pending.deliveryError);
                return pending?.verification ?? null;
              }}
            />
          </>
        )}
        {mode === 'email-sent' && (
          <>
            <h1>{titles['email-sent']}</h1>
            <p role="status" className="account-login-intro">
              {notice} El enlace caduca en 30 minutos. Revisa también la carpeta de spam.
            </p>
          </>
        )}
        {form && (
          <>
            <h1>{titles[mode]}</h1>
            <p className="account-login-intro">{intros[mode]}</p>
            {mode === 'register' && prefill && (
              <p className="small otp-notice" role="status">
                Usamos los datos de tu reserva. Elige una contraseña y verifica tu WhatsApp: al
                hacerlo, tu cita aparecerá en tu cuenta.
              </p>
            )}
            <form key={mode} onSubmit={submit}>
              {mode === 'register' && (
                <div className="form-row">
                  <label>
                    Nombre
                    <input
                      name="firstName"
                      defaultValue={prefill?.firstName}
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
                      defaultValue={prefill?.lastName}
                      autoComplete="family-name"
                      required
                      minLength={2}
                      maxLength={50}
                    />
                  </label>
                </div>
              )}
              {mode === 'forgot-email' && (
                <p className="small">
                  Por seguridad, la contraseña solo se recupera con un correo verificado. Si
                  recuerdas tu contraseña actual, puedes cambiarla en Ajustes. ¿Sin correo
                  verificado? <a href="#contacto">Contáctanos</a>.
                </p>
              )}
              {(mode === 'register' || mode === 'forgot-email') && (
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
                <PhoneField
                  id="auth-phone"
                  label={mode === 'login' ? 'Número de WhatsApp' : 'WhatsApp'}
                  country={country}
                  onCountry={setCountry}
                  autoComplete={mode === 'login' ? 'username' : 'tel-national'}
                  defaultValue={mode === 'register' ? prefillPhone?.national : undefined}
                />
              )}
              {(mode === 'login' || mode === 'register' || mode === 'new-password') && (
                <label>
                  {mode === 'new-password' ? 'Nueva contraseña' : 'Contraseña'}
                  <PasswordInput
                    name="password"
                    minLength={mode === 'login' ? 1 : 12}
                    maxLength={128}
                    autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                    required
                  />
                </label>
              )}
              {mode === 'new-password' && (
                <label>
                  Repite la contraseña
                  <PasswordInput
                    name="confirmPassword"
                    autoComplete="new-password"
                    required
                    minLength={12}
                    maxLength={128}
                  />
                </label>
              )}
              {mode === 'register' && (
                <p className="small">
                  Usa al menos 12 caracteres. Te enviaremos un código por WhatsApp; el correo podrás
                  verificarlo después desde Mi cuenta.
                </p>
              )}
              {mode === 'login' && (
                <button
                  type="button"
                  className="auth-link"
                  onClick={() => changeMode('forgot-email')}
                >
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
                <BusyButton
                  type="submit"
                  className="button"
                  disabled={wait > 0}
                  busy={busy}
                  busyLabel="Procesando…"
                >
                  {wait > 0 ? `Espera ${wait} s` : labels[mode]}
                </BusyButton>
              </div>
            </form>
          </>
        )}
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
