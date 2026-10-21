import { PasswordInput } from '../../components/ui/PasswordInput';
import type { AccountUser, VerificationTicket } from '@instafix/contracts';
import {
  maskEmail,
  maskPhone,
  normalizePhone,
  type CountryCode,
} from '@instafix/contracts/src/phone';
import { useState, type FormEvent } from 'react';
import { BusyButton } from '../../components/ui/BusyButton';
import { api } from '../../lib/api';
import { PhoneField } from './PhoneField';
import { PhoneVerification } from './PhoneVerification';

type Panel = null | 'email' | 'phone' | 'password' | 'verify';

/** Ajustes de la cuenta: WhatsApp (obligatorio), correo (opcional) y contraseña. */
export function AccountSecurity({
  user,
  onUser,
}: {
  user: AccountUser;
  onUser: (user: AccountUser) => void;
}) {
  const [panel, setPanel] = useState<Panel>(null);
  // Acción en curso: solo su botón muestra el indicador; el resto queda desactivado.
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const busy = busyAction !== null;
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
  async function run(key: string, action: () => Promise<void>) {
    setBusyAction(key);
    setError('');
    setMessage('');
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo completar la operación.');
    } finally {
      setBusyAction(null);
    }
  }
  const sendVerification = () =>
    run('email-verification', async () => {
      const result = await api<{
        accepted?: boolean;
        alreadyVerified?: boolean;
        maskedEmail: string;
      }>('my/email/verification', { method: 'POST' });
      // Solo se informa del envío cuando el proveedor aceptó el mensaje.
      setMessage(
        result.alreadyVerified
          ? 'Tu correo ya está verificado.'
          : `Te enviamos un enlace a ${result.maskedEmail}. Caduca en 24 horas; revisa también spam.`,
      );
    });
  /** «Verificar WhatsApp»: envía un código al número de la cuenta y abre el panel del código. */
  const startWhatsAppVerification = () =>
    run('whatsapp', async () => {
      const next = await api<VerificationTicket>('my/phone/verification', { method: 'POST' });
      setPanel('verify');
      setTicket(next);
    });
  async function changeEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await run('email', async () => {
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
    await run('phone', async () => {
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
    await run('password', async () => {
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
        <div className="security-actions">
          {panel === 'verify' ? (
            <button type="button" className="btn btn-ghost btn-small" onClick={() => open(null)}>
              Cancelar
            </button>
          ) : user.phoneVerifiedAt ? null : (
            // Un número verificado no muestra el botón: cada código cuesta un mensaje.
            <BusyButton
              type="button"
              className="btn btn-small btn-primary"
              disabled={busy}
              busy={busyAction === 'whatsapp'}
              busyLabel="Enviando código…"
              aria-controls="security-verify"
              onClick={startWhatsAppVerification}
            >
              Verificar WhatsApp
            </BusyButton>
          )}
          <button
            type="button"
            className={`btn btn-small ${panel === 'phone' ? 'btn-ghost' : 'btn-secondary'}`}
            aria-expanded={panel === 'phone'}
            aria-controls="security-phone"
            onClick={() => open(panel === 'phone' ? null : 'phone')}
          >
            {panel === 'phone' ? 'Cancelar' : 'Cambiar número'}
          </button>
        </div>
      </article>
      {panel === 'verify' && ticket && (
        <div className="security-panel" id="security-verify">
          <PhoneVerification<AccountUser>
            ticket={ticket}
            title="Verifica tu WhatsApp"
            verifyPath="auth/phone/verify"
            resendPath="auth/phone/resend"
            onVerified={(next) => {
              onUser(next);
              setPanel(null);
              setTicket(null);
              setMessage('✓ Tu WhatsApp quedó verificado.');
            }}
          />
        </div>
      )}
      {panel === 'phone' &&
        (ticket ? (
          <div className="security-panel" id="security-phone">
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
          <form className="security-panel" id="security-phone" onSubmit={startPhone}>
            <p className="small">
              Tu número actual se mantiene hasta que verifiques el nuevo con el código que te
              enviaremos por WhatsApp.
            </p>
            <PhoneField
              id="new-phone"
              label="Nuevo WhatsApp"
              country={country}
              onCountry={setCountry}
            />
            <label>
              Contraseña actual
              <PasswordInput name="password" autoComplete="current-password" required />
            </label>
            <div className="security-form-actions">
              <button type="button" className="btn btn-ghost" onClick={() => open(null)}>
                Cancelar
              </button>
              <BusyButton
                type="submit"
                className="btn btn-primary"
                disabled={busy}
                busy={busyAction === 'phone'}
                busyLabel="Enviando…"
              >
                Enviar código
              </BusyButton>
            </div>
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
            <BusyButton
              type="button"
              className="btn btn-primary btn-small"
              disabled={busy}
              busy={busyAction === 'email-verification'}
              busyLabel="Enviando…"
              onClick={sendVerification}
            >
              Verificar correo
            </BusyButton>
          )}
          <button
            type="button"
            className={`btn btn-small ${panel === 'email' ? 'btn-ghost' : 'btn-secondary'}`}
            aria-expanded={panel === 'email'}
            aria-controls="security-email"
            onClick={() => open(panel === 'email' ? null : 'email')}
          >
            {panel === 'email' ? 'Cancelar' : 'Cambiar correo'}
          </button>
        </div>
      </article>
      {panel === 'email' && (
        <form className="security-panel" id="security-email" onSubmit={changeEmail}>
          <label>
            Nuevo correo
            <input name="email" type="email" autoComplete="email" required maxLength={254} />
          </label>
          <label>
            Contraseña actual
            <PasswordInput name="password" autoComplete="current-password" required />
          </label>
          <div className="security-form-actions">
            <button type="button" className="btn btn-ghost" onClick={() => open(null)}>
              Cancelar
            </button>
            <BusyButton
              type="submit"
              className="btn btn-primary"
              disabled={busy}
              busy={busyAction === 'email'}
              busyLabel="Guardando…"
            >
              Guardar correo
            </BusyButton>
          </div>
        </form>
      )}

      <article className="security-item">
        <div>
          <p className="eyebrow">Contraseña</p>
          <strong>••••••••</strong>
        </div>
        <div className="security-actions">
          <button
            type="button"
            className={`btn btn-small ${panel === 'password' ? 'btn-ghost' : 'btn-secondary'}`}
            aria-expanded={panel === 'password'}
            aria-controls="security-password"
            onClick={() => open(panel === 'password' ? null : 'password')}
          >
            {panel === 'password' ? 'Cancelar' : 'Cambiar contraseña'}
          </button>
        </div>
      </article>
      {panel === 'password' && (
        <form className="security-panel" id="security-password" onSubmit={changePassword}>
          <label>
            Contraseña actual
            <PasswordInput name="currentPassword" autoComplete="current-password" required />
          </label>
          <label>
            Nueva contraseña
            <PasswordInput
              name="password"
              autoComplete="new-password"
              minLength={12}
              maxLength={128}
              required
            />
          </label>
          <label>
            Repite la nueva contraseña
            <PasswordInput
              name="confirmPassword"
              autoComplete="new-password"
              minLength={12}
              maxLength={128}
              required
            />
          </label>
          <div className="security-form-actions">
            <button type="button" className="btn btn-ghost" onClick={() => open(null)}>
              Cancelar
            </button>
            <BusyButton
              type="submit"
              className="btn btn-primary"
              disabled={busy}
              busy={busyAction === 'password'}
              busyLabel="Guardando…"
            >
              Guardar contraseña
            </BusyButton>
          </div>
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
