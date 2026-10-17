import { appointmentLabels, appointmentStatuses } from '@instafix/contracts';
import type { ReactNode } from 'react';

type Status = (typeof appointmentStatuses)[number];
const tz = 'America/Guayaquil';
const icons: Record<Status, string> = {
  PENDING_LOCATION: '◷',
  CONFIRMED: '✓',
  IN_PROGRESS: '⚙',
  COMPLETED: '✓',
  CANCELLED: '✕',
};

export function visitDay(value: string, timeZone = tz) {
  const text = new Intl.DateTimeFormat('es-EC', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone,
  }).format(new Date(value));
  return text.charAt(0).toLocaleUpperCase('es') + text.slice(1);
}
export function visitTime(value: string, timeZone = tz) {
  return new Intl.DateTimeFormat('es-EC', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  }).format(new Date(value));
}
/** Día civil (AAAA-MM-DD) en la zona de la visita: «Hoy» no depende de la zona del teléfono. */
export function visitDayKey(value: string | number | Date, timeZone = tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date(value));
}

export function StatusPill({ status }: { status: Status }) {
  return (
    <span className={`status-pill status-${status}`}>
      <span aria-hidden="true">{icons[status]}</span> {appointmentLabels[status]}
    </span>
  );
}

/** Tarjeta común a cliente, administración y técnicos: estado, hora, cliente, solicitud, acciones. */
export function AppointmentCard({
  status,
  startsAt,
  timeZone,
  client,
  request,
  technician,
  details,
  children,
  highlight,
}: {
  status: Status;
  startsAt: string;
  timeZone?: string;
  client?: string;
  request: string;
  technician?: string | null;
  details?: ReactNode;
  children?: ReactNode;
  highlight?: string;
}) {
  return (
    <article className={`appt-card appt-${status}`}>
      <div className="appt-top">
        <StatusPill status={status} />
        {highlight && <span className="appt-highlight">{highlight}</span>}
      </div>
      <p className="appt-when">
        <strong>{visitTime(startsAt, timeZone)}</strong>
        <span>{visitDay(startsAt, timeZone)}</span>
      </p>
      {client && <p className="appt-client">{client}</p>}
      <p className="appt-request">“{request}”</p>
      {(technician !== undefined || details) && (
        <dl className="appt-meta">
          {technician !== undefined && (
            <div>
              <dt>Técnico</dt>
              <dd>{technician || 'Por asignar'}</dd>
            </div>
          )}
          {details}
        </dl>
      )}
      {children && <div className="appt-actions">{children}</div>}
    </article>
  );
}
