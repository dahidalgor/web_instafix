import type { Giveaway } from '@instafix/contracts';

/**
 * Casilla «Participa por {premio}» y número de participaciones del sorteo abierto. Se usa en
 * «Servicios realizados» (aparece al registrar un servicio que cuenta) y al confirmar «completar».
 */
export function GiveawayPicker({
  id,
  giveaway,
  join,
  entries,
  suggested,
  disabled,
  onJoin,
  onEntries,
}: {
  id: string;
  giveaway: Giveaway;
  join: boolean;
  entries: number;
  /** Participaciones según los servicios registrados que cuentan en el sorteo (0 si no hay). */
  suggested: number;
  disabled: boolean;
  onJoin: (value: boolean) => void;
  onEntries: (value: number) => void;
}) {
  return (
    <div className={`tech-giveaway ${join ? 'is-on' : ''}`}>
      <label className="tech-giveaway-check">
        <input
          type="checkbox"
          checked={join}
          disabled={disabled}
          onChange={(e) => onJoin(e.target.checked)}
        />
        <span>
          <strong>Participa por {giveaway.prize}</strong>
          <small>
            {suggested > 0 &&
              `Registraste ${suggested === 1 ? '1 servicio que cuenta' : `${suggested} servicios que cuentan`}. `}
            {giveaway.entryRule}
          </small>
        </span>
      </label>
      {join && (
        <div className="tech-giveaway-qty">
          <span id={`${id}-label`}>Participaciones</span>
          <div className="tech-qty" role="group" aria-labelledby={`${id}-label`}>
            <button
              type="button"
              aria-label="Una participación menos"
              disabled={disabled || entries <= 1}
              onClick={() => onEntries(Math.max(1, entries - 1))}
            >
              −
            </button>
            <output aria-live="polite">{entries}</output>
            <button
              type="button"
              aria-label="Una participación más"
              disabled={disabled || entries >= giveaway.maxEntries}
              onClick={() => onEntries(Math.min(giveaway.maxEntries, entries + 1))}
            >
              +
            </button>
          </div>
        </div>
      )}
      {join && <p className="tech-giveaway-note">Se guarda al marcar la visita como completada.</p>}
    </div>
  );
}
