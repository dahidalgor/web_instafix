import type { ReactNode } from 'react';
import { BusyButton } from '../ui/BusyButton';

/** Cita activa sin la ubicación del cliente (aún no la mandó por WhatsApp). */
export const missingLocation = (a: { status: string; locationReceivedAt?: string | null }) =>
  ['PENDING_LOCATION', 'CONFIRMED'].includes(a.status) && !a.locationReceivedAt;

/** Aviso destacado en la tarjeta y en la hoja de la cita (dentro de su lista `<dl>`). */
export function MissingLocationNote() {
  return (
    <div className="appt-meta-wide tech-location-missing" role="note">
      <dt>
        <span aria-hidden="true">⚠️</span> Sin ubicación
      </dt>
      <dd>El cliente aún no la manda por WhatsApp: todavía no sabes a dónde ir.</dd>
    </div>
  );
}

/**
 * Confirmación adicional antes de aceptar una visita sin la ubicación del cliente: el técnico
 * debe darse cuenta de que todavía no sabe a dónde ir.
 */
export function MissingLocationConfirm({
  client,
  take = false,
  busy = false,
  onCancel,
  onConfirm,
  children,
}: {
  client: string;
  /** Tomar la visita de un reemplazo (en lugar de confirmar una solicitud). */
  take?: boolean;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  children?: ReactNode;
}) {
  return (
    <div
      className="tech-confirm"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="no-location-title"
      aria-describedby="no-location-text"
    >
      <div>
        <h3 id="no-location-title">
          <span aria-hidden="true">⚠️ </span>
          {client} aún no manda su ubicación
        </h3>
        <p id="no-location-text">
          ¿Seguro quieres {take ? 'tomar' : 'aceptar'} esta visita? Todavía no sabes a dónde ir. Se
          la pedimos por WhatsApp; aparecerá en la cita en cuanto la mande.
        </p>
        {children}
        <div className="tech-actions-row">
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            Revisar
          </button>
          <BusyButton
            type="button"
            className="btn btn-primary"
            busy={busy}
            busyLabel={take ? 'Tomando…' : 'Confirmando…'}
            onClick={onConfirm}
          >
            Sí, {take ? 'tomarla' : 'aceptarla'} igual
          </BusyButton>
        </div>
      </div>
    </div>
  );
}
