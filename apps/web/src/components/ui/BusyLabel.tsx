import type { ReactNode } from 'react';

/**
 * Texto de botón que no cambia de ancho entre estados: ambos textos ocupan la misma celda y
 * el más largo fija la medida. Evita que «Cancelando…» empuje o haga saltar a otro botón.
 * En espera muestra un círculo girando junto al texto.
 */
export function BusyLabel({
  busy,
  label,
  busyLabel,
}: {
  busy: boolean;
  label: ReactNode;
  busyLabel?: ReactNode;
}) {
  return (
    <span className="busy-label" data-busy={busy || undefined}>
      <span className="busy-label-idle" aria-hidden={busy || undefined}>
        {label}
      </span>
      <span className="busy-label-busy" aria-hidden={!busy || undefined}>
        <span className="busy-spinner" aria-hidden="true" />
        {busyLabel ?? label}
      </span>
    </span>
  );
}
