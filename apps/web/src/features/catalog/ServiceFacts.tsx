import { duration, warranty } from '../../lib/format';

const ClockIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const ShieldIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path
      d="M12 3.5 5 6.2v5.2c0 4.3 2.9 7.6 7 9.1 4.1-1.5 7-4.8 7-9.1V6.2Z"
      strokeLinejoin="round"
    />
    <path d="m9 12 2.2 2.2L15.5 10" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/**
 * Tiempo estimado y garantía como metadatos (etiqueta + valor), separados de la descripción.
 * `compact` para la tarjeta del catálogo; sin él, bloques del detalle.
 */
export function ServiceFacts({
  durationMinutes,
  warrantyDays,
  compact = false,
}: {
  durationMinutes: number;
  warrantyDays: number;
  compact?: boolean;
}) {
  // Dentro de la tarjeta (un <button>) solo cabe contenido de texto: se usan <span>.
  if (compact)
    return (
      <span className="service-facts is-compact">
        <span>
          <ClockIcon />
          <span className="visually-hidden">Tiempo estimado: </span>
          {duration(durationMinutes)}
        </span>
      </span>
    );
  return (
    <dl className="service-facts">
      <div>
        <ClockIcon />
        <dt>Tiempo estimado</dt>
        <dd>{duration(durationMinutes)}</dd>
      </div>
      {warrantyDays > 0 && (
        <div>
          <ShieldIcon />
          <dt>Garantía</dt>
          <dd>{warranty(warrantyDays)}</dd>
        </div>
      )}
    </dl>
  );
}
