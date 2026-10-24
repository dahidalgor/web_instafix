import { z } from 'zod';

/**
 * Sorteo vigente: cada mando DualSense al que Instafix instala un par de joysticks magnéticos
 * suma una participación. El técnico lo marca al completar la visita.
 */
export const giveaway = {
  prize: 'GTA VI',
  /** Día del sorteo (fecha de Ecuador). Se aceptan participaciones hasta el final de ese día. */
  drawDate: '2026-11-18',
  /** Tope de mandos por visita: evita errores de tecleo, no limita participaciones legítimas. */
  maxEntries: 20,
} as const;

const ecuadorDay = (value: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Guayaquil' }).format(value);

/** El sorteo admite participaciones nuevas (hasta el final del día del sorteo en Ecuador). */
export const giveawayOpen = (now = new Date()) => ecuadorDay(now) <= giveaway.drawDate;

/**
 * Mandos que cuentan en una visita: servicios «Par de joysticks» de PS5 (el mando DualSense; el
 * catálogo lo registra con el equipo «PS5»). Es solo la sugerencia del panel técnico; el técnico
 * confirma la cantidad.
 */
export function suggestedGiveawayEntries(
  services: { nameSnapshot: string; deviceSnapshot: string; quantity: number }[],
) {
  const plain = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  // «PS5»/«DualSense» puede estar en el equipo («PS5») o en el nombre («Par de joysticks PS5»).
  return services
    .filter((s) => plain(s.nameSnapshot).includes('par de joystick'))
    .filter((s) => /\b(ps5|dualsense)\b/.test(plain(`${s.nameSnapshot} ${s.deviceSnapshot}`)))
    .reduce((total, s) => total + s.quantity, 0);
}

/** Cuerpo opcional de «completar visita». Sin cuerpo = no participa. */
export const completeAppointmentSchema = z
  .object({
    giveawayEntries: z.number().int().min(0).max(giveaway.maxEntries).default(0),
  })
  .strict();
