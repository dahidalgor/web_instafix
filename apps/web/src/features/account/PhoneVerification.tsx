import type { VerificationTicket } from '@instafix/contracts';
import { useEffect, useState, type FormEvent } from 'react';
import { BusyButton } from '../../components/ui/BusyButton';
import { api, ApiError } from '../../lib/api';
import { OtpInput } from './OtpInput';

/**
 * Pantalla «Verifica tu WhatsApp». Sirve para registro, cuentas sin verificar, recuperación
 * y cambio de número: cada caso aporta su endpoint de verificación y de reenvío.
 */
export function PhoneVerification<T>({
  ticket,
  title = 'Verifica tu WhatsApp',
  verifyPath,
  resendPath,
  onVerified,
  onResendWithoutTicket,
  submitLabel = 'Verificar',
}: {
  ticket: VerificationTicket | null;
  title?: string;
  verifyPath: string;
  resendPath: string;
  onVerified: (result: T) => void;
  /** Para reintentar cuando el primer envío falló y aún no existe un código. */
  onResendWithoutTicket?: () => Promise<VerificationTicket | null>;
  submitLabel?: string;
}) {
  const [current, setCurrent] = useState(ticket);
  const [code, setCode] = useState('');
  // Una sola acción a la vez: verificar el código o pedir uno nuevo.
  const [action, setAction] = useState<'verify' | 'resend' | null>(null);
  const busy = action !== null;
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [wait, setWait] = useState(ticket ? ticket.resendAfter : 0);
  useEffect(() => {
    if (wait <= 0) return;
    const timer = window.setTimeout(() => setWait((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [wait]);
  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!current || code.length !== 6) return;
    setAction('verify');
    setError('');
    setNotice('');
    try {
      onVerified(
        await api<T>(verifyPath, {
          method: 'POST',
          body: JSON.stringify({ verificationId: current.verificationId, code }),
        }),
      );
    } catch (e) {
      setCode('');
      setError(e instanceof Error ? e.message : 'No se pudo verificar el código.');
    } finally {
      setAction(null);
    }
  }
  useEffect(() => {
    if (code.length === 6 && !busy) void submit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);
  async function resend() {
    setAction('resend');
    setError('');
    setNotice('');
    try {
      const next = current
        ? await api<VerificationTicket>(resendPath, {
            method: 'POST',
            body: JSON.stringify({ verificationId: current.verificationId }),
          })
        : await onResendWithoutTicket?.();
      if (next) {
        setCurrent(next);
        setWait(next.resendAfter);
        setCode('');
        setNotice('Te enviamos un código nuevo. El anterior ya no es válido.');
      }
    } catch (e) {
      if (e instanceof ApiError && typeof e.body?.retryAfter === 'number')
        setWait(e.body.retryAfter);
      setError(e instanceof Error ? e.message : 'No se pudo reenviar.');
    } finally {
      setAction(null);
    }
  }
  return (
    <form className="otp-form" onSubmit={submit}>
      <h1>{title}</h1>
      {current ? (
        <p className="account-login-intro">
          Enviamos un código a:
          <strong className="otp-phone">{current.maskedPhone}</strong>
          Caduca en {Math.round(current.expiresIn / 60)} minutos.
        </p>
      ) : (
        <p className="account-login-intro">
          No pudimos enviar el código todavía. Pulsa «Reenviar» para intentarlo de nuevo.
        </p>
      )}
      <OtpInput value={code} onChange={setCode} disabled={busy || !current} invalid={!!error} />
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
          disabled={busy || !current || code.length !== 6}
          busy={action === 'verify'}
          busyLabel="Verificando…"
        >
          {submitLabel}
        </BusyButton>
      </div>
      <p className="otp-resend">
        ¿No recibiste el código?{' '}
        <BusyButton
          type="button"
          className="auth-link"
          disabled={busy || wait > 0}
          busy={action === 'resend'}
          busyLabel="Reenviando…"
          onClick={resend}
        >
          {wait > 0 ? `Reenviar en ${wait} s` : 'Reenviar'}
        </BusyButton>
      </p>
    </form>
  );
}
