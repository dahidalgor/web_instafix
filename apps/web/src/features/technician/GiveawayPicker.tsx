import { giveaway } from '@instafix/contracts';

/**
 * Casilla «Participa por GTA VI» y número de mandos. Se usa en «Servicios realizados» (aparece
 * al registrar un par de joysticks de PS5) y en la confirmación de «completar».
 */
export function GiveawayPicker({
  id,
  join,
  entries,
  suggested,
  disabled,
  onJoin,
  onEntries,
}: {
  id: string;
  join: boolean;
  entries: number;
  /** Mandos según los «Par de joysticks» de PS5 registrados (0 si no hay). */
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
            {suggested > 0
              ? `Registraste ${suggested === 1 ? '1 par de joysticks de PS5' : `${suggested} pares de joysticks de PS5`}: una participación por cada mando DualSense.`
              : 'Una participación por cada mando DualSense con par de joysticks magnéticos.'}
          </small>
        </span>
      </label>
      {join && (
        <div className="tech-giveaway-qty">
          <span id={`${id}-label`}>Mandos</span>
          <div className="tech-qty" role="group" aria-labelledby={`${id}-label`}>
            <button
              type="button"
              aria-label="Un mando menos"
              disabled={disabled || entries <= 1}
              onClick={() => onEntries(Math.max(1, entries - 1))}
            >
              −
            </button>
            <output aria-live="polite">{entries}</output>
            <button
              type="button"
              aria-label="Un mando más"
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
