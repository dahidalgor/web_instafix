import type { AccountUser, VerificationTicket } from '@instafix/contracts';
import { maskEmail, maskPhone, normalizePhone, type CountryCode } from '@instafix/contracts/src/phone';
import { useState, type FormEvent } from 'react';
import { api } from '../../lib/api';
import { PhoneField } from './PhoneField';
import { PhoneVerification } from './PhoneVerification';

type Panel = null | 'email' | 'phone' | 'password';

/** Mi cuenta → Seguridad: WhatsApp (obligatorio), correo (opcional) y contraseña. */
export function AccountSecurity({
  user,
  onUser,
}: {
  user: AccountUser;
  onUser: (user: AccountUser) => void;
}) {
  const [panel, setPanel] = useState<Panel>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [ticket, setTicket] = useState<VerificationTicket | null>(null);
  const [country, setCountry] = useState<CountryCode>('EC');
  const open = (next: Panel) => {
    setPanel(next);
    setTicket(null);
    setError('');
    setMessage('');
  };
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo completar la operación.');
    } finally {
      setBusy(false);
    }
  }
  const sendVerification = () =>
    run(async () => {
      const result = await api<{ accepted?: boolean; alreadyVerified?: boolean; maskedEmail: string }>(
        'my/email/verification',
        { method: 'POST' },
      );
      // Solo se informa del envío cuando el proveedor aceptó el mensaje.
      setMessage(
        result.alreadyVerified
          ? 'Tu correo ya está verificado.'
          : `Te enviamos un enlace a ${result.maskedEmail}. Caduca en 24 horas; revisa también spam.`,
      );
    });
  async function changeEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await run(async () => {
      onUser(
        await api<AccountUser>('my/email', {
          method: 'POST',
          body: JSON.stringify({ email: data.get('email'), password: data.get('password') }),
        }),
      );
      setPanel(null);
      setMessage('Correo actualizado. Verifícalo para poder recuperar tu cuenta por correo.');
    });
  }
  async function startPhone(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const raw = String(data.get('phone') ?? '');
    await run(async () => {
      setTicket(
        await api<VerificationTicket>('my/phone/change', {
          method: 'POST',
          body: JSON.stringify({
            phone: normalizePhone(raw, country) ?? raw,
            password: data.get('password'),
          }),
        }),
      );
    });
  }
  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    await run(async () => {
      if (data.get('password') !== data.get('confirmPassword'))
        throw new Error('Las contraseñas no coinciden.');
      await api('my/password', {
        method: 'POST',
        body: JSON.stringify({
          currentPassword: data.get('currentPassword'),
          password: data.get('password'),
        }),
      });
      form.reset();
      setPanel(null);
      setMessage('Contraseña actualizada. Cerramos tus otras sesiones.');
    });
  }
  return (
    <div className="security-list">
      <article className="security-item">
        <div>
          <p className="eyebrow">WhatsApp</p>
          <strong>{maskPhone(user.phone)}</strong>
          <span className={user.phoneVerifiedAt ? 'verified' : 'unverified'}>
            {user.phoneVerifiedAt ? '✓ Verificado' : 'Sin verificar'}
          </span>
        </div>
        <button type="button" className="text-button" onClick={() => open(panel === 'phone' ? null : 'phone')}>
          Cambiar número
        </button>
      </article>
      {panel === 'phone' &&
        (ticket ? (
          <div className="security-panel">
            <PhoneVerification<AccountUser>
              ticket={ticket}
              title="Verifica tu nuevo WhatsApp"
              verifyPath="my/phone/change/verify"
              resendPath="my/phone/change/resend"
              onVerified={(next) => {
                onUser(next);
                setPanel(null);
                setTicket(null);
                setMessage('Número actualizado y verificado.');
              }}
            />
          </div>
        ) : (
          <form className="security-panel" onSubmit={startPhone}>
            <p className="small">
              Tu número actual se mantiene hasta que verifiques el nuevo con el código que te
              enviaremos por WhatsApp.
            </p>
            <PhoneField id="new-phone" label="Nuevo WhatsApp" country={country} onCountry={setCountry} />
            <label>
              Contraseña actual
              <input name="password" type="password" autoComplete="current-password" required />
            </label>
            <button className="button" disabled={busy}>
              {busy ? 'Enviando…' : 'Enviar código'}
            </button>
          </form>
        ))}

      <article className="security-item">
        <div>
          <p className="eyebrow">Correo</p>
          <strong>{user.email ? maskEmail(user.email) : 'Sin correo'}</strong>
          {user.email && (
            <span className={user.emailVerifiedAt ? 'verified' : 'unverified'}>
              {user.emailVerifiedAt ? '✓ Verificado' : 'Sin verificar'}
            </span>
          )}
        </div>
        <div className="security-actions">
          {user.email && !user.emailVerifiedAt && (
            <button type="button" className="button" disabled={busy} onClick={sendVerification}>
              Verificar correo
            </button>
          )}
          <button type="button" className="text-button" onClick={() => open(panel === 'email' ? null : 'email')}>
            Cambiar correo
          </button>
        </div>
      </article>
      {panel === 'email' && (
        <form className="security-panel" onSubmit={changeEmail}>
          <label>
            Nuevo correo
            <input name="email" type="email" autoComplete="email" required maxLength={254} />
          </label>
          <label>
            Contraseña actual
            <input name="password" type="password" autoComplete="current-password" required />
          </label>
          <button className="button" disabled={busy}>
            {busy ? 'Guardando…' : 'Guardar correo'}
          </button>
        </form>
      )}

      <article className="security-item">
        <div>
          <p className="eyebrow">Contraseña</p>
          <strong>••••••••</strong>
        </div>
        <button type="button" className="text-button" onClick={() => open(panel === 'password' ? null : 'password')}>
          Cambiar contraseña
        </button>
      </article>
      {panel === 'password' && (
        <form className="security-panel" onSubmit={changePassword}>
          <label>
            Contraseña actual
            <input name="currentPassword" type="password" autoComplete="current-password" required />
          </label>
          <label>
            Nueva contraseña
            <input name="password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required />
          </label>
          <label>
            Repite la nueva contraseña
            <input name="confirmPassword" type="password" autoComplete="new-password" minLength={12} maxLength={128} required />
          </label>
          <button className="button" disabled={busy}>
            {busy ? 'Guardando…' : 'Guardar contraseña'}
          </button>
        </form>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
    </div>
  );
}
