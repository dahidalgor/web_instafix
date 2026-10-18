import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';

type Configuration = {
  configured: boolean;
  missing: string[];
  enabled?: boolean;
  connected?: boolean;
};
type Job = {
  id: string;
  kind: string;
  status: string;
  deliveryStatus: string | null;
  dueAt: string;
  expiresAt: string;
  lastError: string | null;
  appointment: { contactName: string; contactPhone: string; title: string };
};
type Overview = {
  messages: {
    messageId: string;
    phone: string | null;
    bsuid: string | null;
    source: string;
    direction: string;
    type: string;
    text: string | null;
    occurredAt: string;
  }[];
  webhookIssues: number;
  whatsapp: Configuration;
  cal: Configuration;
  jobs: Job[];
  issues: { id: string; contactName: string; title: string; automationIssue: string }[];
};
const kinds: Record<string, string> = {
  INITIAL: 'Solicitar ubicación',
  CAL_CONFIRM: 'Confirmar en Cal.com',
  CONFIRMED: 'Confirmación al cliente',
  DAY_BEFORE: 'Recordatorio del día anterior',
  SAME_DAY: 'Recordatorio del mismo día',
};
const statuses: Record<string, string> = {
  PENDING: 'Pendiente',
  RETRY: 'Reintento programado',
  SENDING: 'Procesando',
  SENT: 'Aceptado por el proveedor',
  CANCELLED: 'Cancelado',
  FAILED: 'Fallido',
  REVIEW: 'Requiere revisión',
  sent: 'Enviado',
  delivered: 'Entregado',
  read: 'Leído',
  failed: 'Entrega fallida',
};

export function AdminWhatsApp() {
  const [data, setData] = useState<Overview | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const connection = useRef<{
    popup: Window;
    state: string;
    expiresAt: number;
    openedAt: number;
  } | null>(null);
  /** Ventana de conexión abierta y último error, para mostrarlo dentro del popup. */
  const popupRef = useRef<Window | null>(null);
  const popupError = useRef<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  // Resultado del intento para los registros del servidor (sin datos sensibles).
  const report = (outcome: string, detail?: string) =>
    api('admin/whatsapp/connect/event', {
      method: 'POST',
      body: JSON.stringify({ outcome, ...(detail ? { detail: detail.slice(0, 300) } : {}) }),
    }).catch(() => {});
  function showPopupError(popup: Window, reason: string) {
    popupError.current = reason;
    if (!popup.closed)
      popup.postMessage({ type: 'INSTAFIX_WA_ERROR', message: reason }, window.location.origin);
  }
  async function load() {
    setData(await api<Overview>('admin/whatsapp'));
  }
  useEffect(() => {
    load().catch((error) => setMessage(error.message));
    function onMessage(event: MessageEvent) {
      // Mensajes de la página intermedia propia (/whatsapp-connect.html).
      if (
        event.origin === window.location.origin &&
        event.source &&
        event.source === popupRef.current &&
        event.data?.type
      ) {
        if (event.data.type === 'INSTAFIX_WA_READY' && popupError.current)
          showPopupError(popupRef.current, popupError.current);
        if (event.data.type === 'INSTAFIX_WA_RETRY') void startSession(popupRef.current);
        return;
      }
      const pending = connection.current;
      if (
        !pending ||
        event.origin !== 'https://officialapi.wasapflow.com' ||
        event.source !== pending.popup ||
        event.data?.state !== pending.state
      )
        return;
      if (
        ![
          'WASAPFLOW_CONNECT_SUCCESS',
          'WASAPFLOW_CONNECT_CANCEL',
          'WASAPFLOW_CONNECT_ERROR',
        ].includes(event.data.type)
      )
        return;
      connection.current = null;
      setConnecting(false);
      if (event.data.type !== 'WASAPFLOW_CONNECT_SUCCESS') {
        const reason =
          typeof event.data.error?.message === 'string'
            ? event.data.error.message
            : typeof event.data.message === 'string'
              ? event.data.message
              : '';
        const cancelled = event.data.type === 'WASAPFLOW_CONNECT_CANCEL';
        void report(cancelled ? 'WASAPFLOW_CANCEL' : 'WASAPFLOW_ERROR', reason);
        setMessage(
          cancelled
            ? 'Cancelaste la conexión en WasapFlow. Puedes volver a intentarlo.'
            : `WasapFlow no completó la conexión${reason ? `: ${reason}` : '.'} Puedes volver a intentarlo.`,
        );
        return;
      }
      if (event.data.connection_mode !== 'coexistence') {
        setMessage(
          'Conexión no aceptada: es obligatorio conservar WhatsApp Business App mediante Coexistence.',
        );
        return;
      }
      setBusy(true);
      api('admin/whatsapp/connect/complete', {
        method: 'POST',
        body: JSON.stringify({
          state: pending.state,
          waba_id: event.data.waba_id,
          connection_mode: event.data.connection_mode,
        }),
      })
        .then(() => {
          setMessage('Número conectado mediante WasapFlow Coexistence.');
          return load();
        })
        .catch((error) => {
          void report('COMPLETE_FAILED', error.message);
          setMessage(error.message);
        })
        .finally(() => setBusy(false));
    }
    window.addEventListener('message', onMessage);
    const timer = window.setInterval(() => {
      const pending = connection.current;
      if (pending && (pending.popup.closed || Date.now() > pending.expiresAt)) {
        connection.current = null;
        setConnecting(false);
        const seconds = Math.round((Date.now() - pending.openedAt) / 1000);
        void report(
          pending.popup.closed ? 'POPUP_CLOSED_WITHOUT_RESULT' : 'SESSION_EXPIRED',
          `${seconds}s`,
        );
        setMessage(
          pending.popup.closed && seconds < 15
            ? 'La ventana de WasapFlow se cerró sin devolver un resultado a los pocos segundos. Suele deberse a que el navegador bloqueó la ventana de Meta o a una restricción del sitio de WasapFlow. Vuelve a intentarlo; si se repite, revisa el diagnóstico de WhatsApp.'
            : 'La ventana se cerró o la sesión caducó sin completar la conexión. Vuelve a conectar para continuar.',
        );
      }
    }, 1000);
    return () => {
      window.removeEventListener('message', onMessage);
      window.clearInterval(timer);
    };
  }, []);
  async function startSession(popup: Window) {
    setConnecting(true);
    setMessage('');
    popupError.current = null;
    try {
      const result = await api<{ connect_url: string; state: string; expires_in: number }>(
        'admin/whatsapp/connect/session',
        { method: 'POST' },
      );
      if (popup.closed) {
        setConnecting(false);
        setMessage('Cerraste la ventana antes de abrir WasapFlow. Vuelve a intentarlo.');
        return;
      }
      connection.current = {
        popup,
        state: result.state,
        expiresAt: Date.now() + (result.expires_in + 1800) * 1000,
        openedAt: Date.now(),
      };
      popup.location.replace(result.connect_url);
    } catch (error) {
      // La ventana NO se cierra: muestra el motivo y permite reintentar o cerrar.
      const reason = error instanceof Error ? error.message : 'No se pudo iniciar la conexión';
      showPopupError(popup, reason);
      setConnecting(false);
      setMessage(reason);
    }
  }
  async function connect() {
    if (connecting) return;
    const popup = window.open(
      '/whatsapp-connect.html',
      'instafix-wasapflow',
      'width=700,height=800',
    );
    if (!popup) {
      setMessage(
        `El navegador bloqueó la ventana emergente. Permite ventanas emergentes para ${window.location.host} y vuelve a pulsar el botón.`,
      );
      return;
    }
    popupRef.current = popup;
    await startSession(popup);
  }
  async function refresh(id?: string) {
    setBusy(true);
    setMessage('');
    try {
      if (id) await api(`admin/whatsapp/${id}/retry`, { method: 'POST' });
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'No se pudo actualizar');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="whatsapp-admin">
      <h2>WhatsApp y citas</h2>
      <p>WasapFlow Bridge · Coexistence. Tu número seguirá funcionando en WhatsApp Business App.</p>
      <button
        type="button"
        className="btn btn-primary"
        aria-busy={connecting}
        disabled={busy || connecting || data?.whatsapp.connected}
        onClick={connect}
      >
        {connecting
          ? 'Conectando…'
          : data?.whatsapp.connected
            ? 'Conectado con Coexistence'
            : 'Conectar WhatsApp Business'}
      </button>
      <p>
        Recordatorios a las 08:00, hora de Ecuador continental. Los mensajes se envían únicamente
        con autorización del cliente.
      </p>
      <button className="btn btn-secondary btn-small" disabled={busy} onClick={() => refresh()}>
        Actualizar estado
      </button>
      {message && <p role="status">{message}</p>}
      {data && (
        <>
          <div className="whatsapp-status">
            <h3>
              {data.whatsapp.enabled &&
              data.whatsapp.configured &&
              data.whatsapp.connected &&
              data.cal.configured
                ? 'Automatización habilitada'
                : 'Automatización pendiente de activación'}
            </h3>
            <p>
              La configuración completa no garantiza la entrega: comprueba abajo el resultado de
              cada mensaje.
            </p>
            {[...data.whatsapp.missing, ...data.cal.missing].length > 0 && (
              <details>
                <summary>Configuración pendiente</summary>
                <ul>
                  {[...data.whatsapp.missing, ...data.cal.missing].map((key) => (
                    <li key={key}>
                      <code>{key}</code>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
          {data.issues.length > 0 && (
            <div>
              <h3>Citas que necesitan atención</h3>
              {data.issues.map((issue) => (
                <p key={issue.id}>
                  <strong>
                    {issue.contactName} · {issue.title}:
                  </strong>{' '}
                  {issue.automationIssue}
                </p>
              ))}
            </div>
          )}
          <h3>Últimos mensajes y confirmaciones</h3>
          {!data.jobs.length && <p>Todavía no hay mensajes programados.</p>}
          <div className="whatsapp-jobs">
            {data.jobs.map((job) => (
              <article key={job.id}>
                <h4>{kinds[job.kind] || job.kind}</h4>
                <p>
                  {job.appointment.contactName} · {job.appointment.contactPhone}
                  <br />
                  {job.appointment.title}
                </p>
                <p>
                  <strong>{statuses[job.status] || job.status}</strong>
                  {job.deliveryStatus && ` · ${statuses[job.deliveryStatus] || job.deliveryStatus}`}
                </p>
                <p className="small">
                  Programado:{' '}
                  {new Date(job.dueAt).toLocaleString('es-EC', { timeZone: 'America/Guayaquil' })}{' '}
                  (Ecuador)
                </p>
                {job.lastError && <p>{job.lastError}</p>}
                {job.status === 'REVIEW' && (
                  <p className="small">
                    Comprueba el envío en WasapFlow antes de contactar al cliente manualmente, para
                    evitar duplicados.
                  </p>
                )}
                {(job.status === 'FAILED' || job.deliveryStatus === 'failed') &&
                  new Date(job.expiresAt) > new Date() && (
                    <button
                      className="btn btn-secondary btn-small"
                      disabled={busy}
                      onClick={() => refresh(job.id)}
                    >
                      Reintentar envío fallido
                    </button>
                  )}
              </article>
            ))}
          </div>
          {data.webhookIssues > 0 && (
            <p role="status">
              Hay {data.webhookIssues} eventos de WasapFlow que requieren revisión.
            </p>
          )}
          <h3>Actividad reciente del chat</h3>
          <p className="small">
            Incluye mensajes automáticos, respuestas desde el teléfono e historial sincronizado. Los
            ecos e históricos no disparan automatizaciones.
          </p>
          {!data.messages.length && (
            <p>Los mensajes aparecerán cuando conectes el número y actives el webhook.</p>
          )}
          <div className="whatsapp-jobs">
            {data.messages.map((item) => (
              <article key={item.messageId}>
                <strong>{item.phone || item.bsuid || 'Contacto sin teléfono'}</strong>
                <p className="small">
                  {(
                    {
                      customer_live: 'Cliente',
                      business_app: 'WhatsApp Business App',
                      api: 'API',
                      history: 'Historial',
                    } as Record<string, string>
                  )[item.source] || item.source}{' '}
                  · {new Date(item.occurredAt).toLocaleString('es-EC')}
                </p>
                <p>{item.text || `[${item.type}]`}</p>
              </article>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
