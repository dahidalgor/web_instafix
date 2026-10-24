import { BusyButton } from '../../components/ui/BusyButton';
import { ListSkeleton } from '../../components/ui/Skeleton';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';

type Configuration = { configured: boolean; missing: string[]; enabled?: boolean };
type Account = {
  provider: string;
  number: {
    phone: string | null;
    status: string;
    coexistence: boolean | null;
    quality: string | null;
    messagingLimit: string | null;
  } | null;
  templates: { name: string; status: string; language: string | null; problem: string | null }[];
  authenticationTemplate: { name: string; status: string } | null;
  error: string | null;
};
type Job = {
  id: string;
  kind: string;
  status: string;
  deliveryStatus: string | null;
  dueAt: string;
  expiresAt: string;
  lastError: string | null;
  suppressedReason?: string | null;
  eventType?: string;
  appointment: { contactName: string; contactPhone: string; title: string };
};
type Overview = {
  messages: {
    provider: string;
    providerMessageId: string;
    phone: string | null;
    bsuid: string | null;
    source: string;
    direction: string;
    type: string;
    text: string | null;
    occurredAt: string;
    outcome: string | null;
  }[];
  webhookIssues: number;
  whatsapp: Configuration & { businessPhone: string };
  account: Account | null;
  otp: Configuration & { template: string };
  cal: Configuration;
  jobs: Job[];
  issues: { id: string; contactName: string; title: string; automationIssue: string }[];
};
const kinds: Record<string, string> = {
  INITIAL: 'Solicitud recibida (pide ubicación)',
  CAL_CONFIRM: 'Confirmar en Cal.com',
  CONFIRMED: 'Cita confirmada',
  DAY_BEFORE: 'Recordatorio del día anterior',
  SAME_DAY: 'Recordatorio del mismo día (retirado)',
  RESCHEDULED: 'Cita reprogramada',
  CANCELLED: 'Cita cancelada',
  TECHNICIAN_ASSIGNED: 'Técnico asignado (retirado)',
  TECHNICIAN_ON_THE_WAY: 'Técnico en camino (retirado)',
};
const statuses: Record<string, string> = {
  PENDING: 'Pendiente',
  RETRY: 'Reintento programado',
  SENDING: 'Procesando',
  SENT: 'Aceptado por Bird',
  CANCELLED: 'Cancelado',
  FAILED: 'Fallido',
  REVIEW: 'Requiere revisión',
  // Omitidos a propósito (control de costos): la cita siguió su curso; nunca se reintentan.
  SUPPRESSED_BUDGET: 'Omitido: presupuesto de WhatsApp alcanzado',
  SUPPRESSED_RATE_LIMIT: 'Omitido: límite de envíos por número o IP',
  SUPPRESSED_DISABLED: 'Omitido: envíos desactivados (WHATSAPP_SENDING_ENABLED)',
  SUPPRESSED_BLOCKED: 'Omitido: número bloqueado',
};
const deliveries: Record<string, string> = {
  SENT: 'Enviado',
  DELIVERED: 'Entregado',
  READ: 'Leído',
  FAILED: 'Entrega fallida',
};
const numberStatuses: Record<string, string> = {
  connected: 'Conectado',
  awaiting_signup: 'Falta terminar el registro en Bird',
  pending: 'Pendiente',
  preparing: 'Preparando',
  disconnected: 'Desconectado',
  restricted: 'Restringido por Meta',
  flagged: 'Marcado por Meta',
  banned: 'Bloqueado por Meta',
  rate_limited: 'Límite de envíos',
};
const templateStatuses: Record<string, string> = {
  active: 'Aprobada',
  pending: 'En revisión',
  draft: 'Borrador',
  rejected: 'Rechazada',
  inactive: 'Inactiva',
  missing: 'No existe en Bird',
  error: 'No se pudo leer',
};
const outcomes: Record<string, string> = {
  LOCATION_ACCEPTED: '📍 Ubicación guardada en su cita',
  LOCATION_UPDATED: '📍 Ubicación actualizada en su cita',
  AMBIGUOUS_LOCATION: '📍 Tiene varias citas pendientes: asígnala a mano',
  NO_MATCHING_APPOINTMENT: '📍 No tiene una cita pendiente con este número',
  LOCATION_BEFORE_BOOKING: '📍 Enviada antes de agendar: no se usó',
};
const sources: Record<string, string> = {
  customer_live: 'Cliente',
  business_app: 'WhatsApp Business App',
  api: 'Instafix (automático)',
  history: 'Historial',
};

export function AdminWhatsApp() {
  const [data, setData] = useState<Overview | null>(null);
  const [message, setMessage] = useState('');
  // Acción en curso («refresh» o el id del envío): solo su botón muestra la espera.
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const busy = busyAction !== null;
  async function load() {
    setData(await api<Overview>('admin/whatsapp'));
  }
  useEffect(() => {
    load().catch((error) => setMessage(error.message));
  }, []);
  async function refresh(id?: string) {
    setBusyAction(id ?? 'refresh');
    setMessage('');
    try {
      if (id) await api(`admin/whatsapp/${id}/retry`, { method: 'POST' });
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'No se pudo actualizar');
    } finally {
      setBusyAction(null);
    }
  }
  const number = data?.account?.number;
  const ready =
    data &&
    data.whatsapp.enabled &&
    data.whatsapp.configured &&
    number?.status === 'connected' &&
    data.cal.configured;
  const missing = data ? [...data.whatsapp.missing, ...data.cal.missing] : [];
  return (
    <section className="whatsapp-admin">
      <p>
        Bird · Coexistence: el número sigue funcionando en WhatsApp Business App. Se conecta una
        sola vez desde el panel de Bird; aquí solo se muestra su estado.
      </p>
      <p>
        Recordatorio el día anterior a las 08:00, hora de Ecuador continental. Los mensajes se
        envían únicamente con autorización del cliente.
      </p>
      <BusyButton
        className="btn btn-secondary btn-small"
        disabled={busy}
        busy={busyAction === 'refresh'}
        busyLabel="Actualizando…"
        onClick={() => refresh()}
      >
        Actualizar estado
      </BusyButton>
      {message && <p role="status">{message}</p>}
      {!data && !message && <ListSkeleton label="Cargando WhatsApp…" count={3} />}
      {data && (
        <>
          <div className="whatsapp-status">
            <h3>
              {ready ? 'Automatización habilitada' : 'Automatización pendiente de activación'}
            </h3>
            {!data.whatsapp.enabled && (
              <p>
                Envíos desactivados: <code>WHATSAPP_ENABLED</code> no es <code>true</code>.
              </p>
            )}
            {data.account?.error && <p role="alert">{data.account.error}</p>}
            {number ? (
              <p>
                <strong>{number.phone}</strong> · {numberStatuses[number.status] || number.status}
                {' · '}
                Coexistence: {number.coexistence ? 'sí' : number.coexistence === false ? 'no' : '—'}
                {number.quality && ` · calidad ${number.quality}`}
                {number.messagingLimit && ` · límite ${number.messagingLimit}`}
              </p>
            ) : (
              data.account &&
              !data.account.error && (
                <p>
                  El número {data.whatsapp.businessPhone} no aparece conectado en este workspace de
                  Bird.
                </p>
              )
            )}
            <p>
              La configuración completa no garantiza la entrega: comprueba abajo el resultado de
              cada mensaje.
            </p>
            {missing.length > 0 && (
              <details>
                <summary>Configuración pendiente</summary>
                <ul>
                  {missing.map((key) => (
                    <li key={key}>
                      <code>{key}</code>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
          {data.account && data.account.templates.length > 0 && (
            <div>
              <h3>Plantillas</h3>
              <ul>
                {data.account.templates.map((template) => (
                  <li key={template.name}>
                    <code>{template.name}</code> ·{' '}
                    {templateStatuses[template.status] || template.status}
                    {template.language && ` · ${template.language}`}
                    {template.problem && <span className="small"> · {template.problem}</span>}
                  </li>
                ))}
              </ul>
              <p className="small">
                Código de verificación: <code>{data.otp.template}</code> (plantilla de Bird) ·{' '}
                {data.otp.enabled ? 'activado' : 'desactivado (WHATSAPP_OTP_ENABLED)'}
                {data.account.authenticationTemplate &&
                  ` · ${templateStatuses[data.account.authenticationTemplate.status] || data.account.authenticationTemplate.status}`}
              </p>
            </div>
          )}
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
                  {job.deliveryStatus &&
                    ` · ${deliveries[job.deliveryStatus.toUpperCase()] || job.deliveryStatus}`}
                </p>
                <p className="small">
                  Programado:{' '}
                  {new Date(job.dueAt).toLocaleString('es-EC', { timeZone: 'America/Guayaquil' })}{' '}
                  (Ecuador)
                </p>
                {job.lastError && <p>{job.lastError}</p>}
                {job.suppressedReason && <p className="small">Motivo: {job.suppressedReason}</p>}
                {job.status === 'REVIEW' && (
                  <p className="small">
                    Comprueba el envío en Bird (WhatsApp → Mensajes) antes de contactar al cliente
                    manualmente, para evitar duplicados.
                  </p>
                )}
                {(job.status === 'FAILED' || job.deliveryStatus?.toUpperCase() === 'FAILED') &&
                  new Date(job.expiresAt) > new Date() && (
                    <BusyButton
                      className="btn btn-secondary btn-small"
                      disabled={busy}
                      busy={busyAction === job.id}
                      busyLabel="Reintentando…"
                      onClick={() => refresh(job.id)}
                    >
                      Reintentar envío fallido
                    </BusyButton>
                  )}
              </article>
            ))}
          </div>
          {data.webhookIssues > 0 && (
            <p role="status">Hay {data.webhookIssues} eventos de Bird que requieren revisión.</p>
          )}
          <h3>Actividad reciente del chat</h3>
          <p className="small">
            Incluye mensajes automáticos, respuestas desde el teléfono e historial sincronizado. Los
            ecos e históricos no disparan automatizaciones.
          </p>
          {!data.messages.length && (
            <p>Los mensajes aparecerán cuando el webhook de Bird esté registrado.</p>
          )}
          <div className="whatsapp-jobs">
            {data.messages.map((item) => (
              <article key={`${item.provider}:${item.providerMessageId}`}>
                <strong>{item.phone || item.bsuid || 'Contacto sin teléfono'}</strong>
                <p className="small">
                  {sources[item.source] || item.source} ·{' '}
                  {new Date(item.occurredAt).toLocaleString('es-EC')}
                  {item.provider !== 'BIRD' && ` · ${item.provider}`}
                </p>
                <p>{item.text || `[${item.type}]`}</p>
                {item.outcome && outcomes[item.outcome] && (
                  <p className="small">{outcomes[item.outcome]}</p>
                )}
              </article>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
