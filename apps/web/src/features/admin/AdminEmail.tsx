import { useEffect, useState } from 'react';
import { api } from '../../lib/api';

type LogRow = {
  channel: string;
  provider: string;
  kind: string;
  recipient: string;
  status: string;
  providerMessageId: string | null;
  error: string | null;
  createdAt: string;
};
type MailStatus = {
  configured: boolean;
  missing: string[];
  validPort: boolean;
  provider: string;
  replyTo: boolean;
  appointmentEmails: boolean;
  recent: LogRow[];
};
export function AdminEmail() {
  const [status, setStatus] = useState<MailStatus | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [to, setTo] = useState('');
  const load = () =>
    api<MailStatus>('admin/email/status')
      .then(setStatus)
      .catch((e) => setMessage(e.message));
  useEffect(() => {
    void load();
  }, []);
  async function run(path: string, body?: unknown) {
    setBusy(true);
    setMessage('');
    try {
      const result = await api<{ message: string }>(path, {
        method: 'POST',
        body: body ? JSON.stringify(body) : undefined,
      });
      setMessage(result.message);
      await load();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'No se pudo completar');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="editor">
      <h2>Comunicaciones</h2>
      <p>
        Instafix envía sus correos por Brevo: verificación de correo, recuperación de contraseña y
        avisos de citas. Cal.com solo gestiona la agenda.
      </p>
      {status && (
        <>
          <strong>
            {status.configured
              ? `Correo configurado (${status.provider})`
              : 'Correo pendiente de configurar'}
          </strong>
          {!!status.missing.length && <p className="small">Faltan: {status.missing.join(', ')}</p>}
          {!status.validPort && (
            <p role="alert">Usa el puerto SMTP indicado por tu proveedor: 465 o 587.</p>
          )}
          <p className="small">
            Reply-To{' '}
            {status.replyTo ? 'configurado' : 'sin configurar (las respuestas van al remitente)'}.
            Avisos de citas por correo:{' '}
            {status.appointmentEmails
              ? 'activados («Recibimos tu solicitud» y «Tu visita está confirmada»)'
              : 'DESACTIVADOS: ningún cliente recibe correos de sus citas. Pon APPOINTMENT_EMAILS_ENABLED=true en el servidor (con CAL_ATTENDEE_RELAY_EMAIL configurado para que Cal.com no duplique).'}
            .
          </p>
          <button
            className="btn btn-secondary"
            disabled={busy || !status.configured}
            onClick={() => run('admin/email/verify')}
          >
            {busy ? 'Comprobando…' : 'Comprobar conexión sin enviar correo'}
          </button>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run('admin/email/test', { email: to });
            }}
          >
            <label>
              Enviar correo de prueba a un buzón propio
              <input type="email" required value={to} onChange={(e) => setTo(e.target.value)} />
            </label>
            <button className="btn btn-primary" disabled={busy || !status.configured}>
              Enviar prueba real
            </button>
          </form>
          <p className="small">
            «Aceptado» significa que Brevo recibió el mensaje. La llegada a la bandeja se comprueba
            en el buzón y en los eventos de Brevo.
          </p>
          <h3>Últimos envíos</h3>
          {!status.recent.length && <p className="small">Todavía no hay envíos registrados.</p>}
          <ul className="comm-log">
            {status.recent.map((row, i) => (
              <li key={i}>
                <strong>
                  {row.status === 'ACCEPTED'
                    ? '✓ Aceptado por Brevo'
                    : row.status === 'SKIPPED'
                      ? '— No enviado'
                      : '✕ Fallido'}
                </strong>{' '}
                · {row.channel} · {row.kind} · {row.recipient} ·{' '}
                {new Date(row.createdAt).toLocaleString('es-EC')}
                {row.error && <span> · {row.error}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="small">
        Esta pantalla nunca muestra contraseñas, códigos ni tokens. Los destinatarios aparecen
        enmascarados.
      </p>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
