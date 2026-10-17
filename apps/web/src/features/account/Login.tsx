import type { AccountUser, VerificationTicket } from '@instafix/contracts';
import { type CountryCode, normalizePhone } from '@instafix/contracts/src/phone';
import { useState, type FormEvent, type ReactNode } from 'react';
import { api, ApiError } from '../../lib/api';
import { PhoneField } from './PhoneField';
import { PhoneVerification } from './PhoneVerification';

type Mode =
  | 'login'
  | 'register'
  | 'verify'
  | 'forgot'
  | 'forgot-whatsapp'
  | 'forgot-email'
  | 'reset-code'
  | 'email-sent'
  | 'new-password';

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
  const [mode, setMode] = useState<Mode>(initialResetToken ? 'new-password' : 'login');
  const [country, setCountry] = useState<CountryCode>('EC');
  const [ticket, setTicket] = useState<VerificationTicket | null>(null);
  const [credentials, setCredentials] = useState<{ phone: string; password: string } | null>(null);
  const [resetToken, setResetToken] = useState(initialResetToken || '');
  const [email, setEmail] = useState('');
  const [error, setError] = useState<ReactNode>('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const changeMode = (next: Mode) => {
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
        } catch (e) {
          if (e instanceof ApiError && e.code === 'PHONE_IN_USE') {
            setError(
              <>
                {e.message}{' '}
                <button type="button" className="auth-link" onClick={() => changeMode('login')}>
                  Iniciar sesión
                </button>{' '}
                ·{' '}
                <button type="button" className="auth-link" onClick={() => changeMode('forgot')}>
                  Recuperar contraseña
                </button>
              </>,
            );
            return;
          }
          throw e;
        }
      } else if (mode === 'forgot-whatsapp') {
        const result = await api<VerificationTicket & { message: string }>(
          'auth/password-reset/whatsapp',
          { method: 'POST', body: JSON.stringify({ phone: phoneFrom(data) }) },
        );
        setTicket(result);
        setMode('reset-code');
        setNotice(result.message);
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
      setError(e instanceof Error ? e.message : 'No se pudo completar la solicitud.');
    } finally {
      setBusy(false);
    }
  }

  const titles: Partial<Record<Mode, string>> = {
    login: 'Iniciar sesión',
    register: 'Crea tu cuenta',
    forgot: 'Recupera tu acceso',
    'forgot-whatsapp': 'Recuperar por WhatsApp',
    'forgot-email': 'Recuperar por correo',
    'email-sent': 'Revisa tu correo',
    'new-password': 'Nueva contraseña',
  };
  const intros: Partial<Record<Mode, string>> = {
    login: 'Tus citas, servicios y garantías en un solo lugar.',
    register: 'Verificaremos tu número por WhatsApp para activar tu cuenta.',
    forgot: 'Elige cómo quieres recuperar tu cuenta. Solo funcionan los canales ya verificados.',
    'forgot-whatsapp': 'Escribe el WhatsApp verificado de tu cuenta.',
    'forgot-email': 'Escribe el correo verificado de tu cuenta.',
    'new-password': 'Elige una contraseña nueva de al menos 12 caracteres.',
  };
  const labels: Partial<Record<Mode, string>> = {
    login: 'Entrar',
    register: 'Crear cuenta',
    'forgot-whatsapp': 'Enviar código',
    'forgot-email': 'Enviar enlace',
    'new-password': 'Guardar contraseña',
  };
  const form = !['verify', 'reset-code', 'forgot', 'email-sent'].includes(mode);

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
        {mode === 'reset-code' && (
          <>
            {notice && (
              <p role="status" className="small otp-notice">
                {notice}
              </p>
            )}
            <PhoneVerification<{ resetToken: string }>
              key={ticket?.verificationId ?? 'pending'}
              title="Código de recuperación"
              ticket={ticket}
              verifyPath="auth/password-reset/whatsapp/verify"
              resendPath="auth/phone/resend"
              submitLabel="Continuar"
              onVerified={(result) => {
                setResetToken(result.resetToken);
                changeMode('new-password');
              }}
            />
          </>
        )}
        {mode === 'forgot' && (
          <>
            <h1>{titles.forgot}</h1>
            <p className="account-login-intro">{intros.forgot}</p>
            <div className="recovery-options">
              <button className="button" onClick={() => changeMode('forgot-whatsapp')}>
                Recuperar por WhatsApp
              </button>
              <button className="button secondary" onClick={() => changeMode('forgot-email')}>
                Recuperar por correo
              </button>
            </div>
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
              {(mode === 'login' || mode === 'register' || mode === 'forgot-whatsapp') && (
                <PhoneField
                  id="auth-phone"
                  label={mode === 'login' ? 'Número de WhatsApp' : 'WhatsApp'}
                  country={country}
                  onCountry={setCountry}
                  autoComplete={mode === 'login' ? 'username' : 'tel-national'}
                />
              )}
              {(mode === 'login' || mode === 'register' || mode === 'new-password') && (
                <label>
                  {mode === 'new-password' ? 'Nueva contraseña' : 'Contraseña'}
                  <input
                    name="password"
                    type="password"
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
              {mode === 'register' && (
                <p className="small">
                  Usa al menos 12 caracteres. Te enviaremos un código por WhatsApp; el correo podrás
                  verificarlo después desde Mi cuenta.
                </p>
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
