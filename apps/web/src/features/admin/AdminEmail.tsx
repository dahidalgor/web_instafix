import { useEffect, useState } from 'react';
import { api } from '../../lib/api';

type MailStatus = { configured: boolean; missing: string[]; validPort: boolean };
export function AdminEmail() {
  const [status, setStatus] = useState<MailStatus | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<MailStatus>('admin/email/status')
      .then(setStatus)
      .catch((e) => setMessage(e.message));
  }, []);
  async function verify() {
    setBusy(true);
    setMessage('');
    try {
      const result = await api<{ message: string }>('admin/email/verify', { method: 'POST' });
      setMessage(result.message);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'No se pudo comprobar');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="editor">
      <h2>Correo de verificación</h2>
      <p>
        Para enviar códigos desde instafix.ec, conecta un proveedor de correo. El dominio por sí
        solo no envía mensajes.
      </p>
      <ol>
        <li>Crea una cuenta con un proveedor que permita enviar por SMTP.</li>
        <li>Verifica instafix.ec añadiendo en su DNS los registros que te indique el proveedor.</li>
        <li>
          Configura en el servidor su host, puerto, usuario, contraseña y remitente autorizado.
          Reinicia la API.
        </li>
        <li>
          Comprueba la conexión y registra una cuenta de prueba con un correo al que tengas acceso.
        </li>
      </ol>
      {status && (
        <>
          <strong>
            {status.configured ? 'Configuración presente' : 'Pendiente de configurar'}
          </strong>
          {!!status.missing.length && <p className="small">Faltan: {status.missing.join(', ')}</p>}
          {!status.validPort && (
            <p role="alert">Usa el puerto SMTP indicado por tu proveedor: 465 o 587.</p>
          )}
          <button disabled={busy || !status.configured} onClick={verify}>
            {busy ? 'Comprobando…' : 'Comprobar conexión sin enviar correo'}
          </button>
        </>
      )}
      <p className="small">
        Esta pantalla nunca muestra ni guarda contraseñas. Los códigos siguen caducando a los 10
        minutos y son de un solo uso.
      </p>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
