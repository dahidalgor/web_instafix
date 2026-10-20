/**
 * Texto de botón que no cambia de ancho entre estados: ambos textos ocupan la misma celda y
 * el más largo fija la medida. Evita que «Cancelando…» empuje o haga saltar a otro botón.
 */
export function BusyLabel({
  busy,
  label,
  busyLabel,
}: {
  busy: boolean;
  label: string;
  busyLabel: string;
}) {
  return (
    <span className="busy-label" data-busy={busy || undefined}>
      <span className="busy-label-idle" aria-hidden={busy || undefined}>
        {label}
      </span>
      <span className="busy-label-busy" aria-hidden={!busy || undefined}>
        <span className="busy-spinner" aria-hidden="true" />
        {busyLabel}
      </span>
    </span>
  );
}
