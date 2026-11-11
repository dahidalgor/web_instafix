import { z } from 'zod';

/**
 * Sorteos para clientes. Se crean y cierran desde Administración → Sorteos (no hay datos fijos en
 * el código). Solo uno abierto a la vez: el técnico marca las participaciones al completar una
 * visita y el cliente las ve en su cuenta mientras el sorteo siga abierto.
 */
export type Giveaway = {
  id: string;
  prize: string;
  /** Día del sorteo (fecha de Ecuador). Se aceptan participaciones hasta el final de ese día. */
  drawDate: string;
  /** Cómo se participa (lo leen técnicos y clientes). */
  entryRule: string;
  /** Tope de participaciones por visita: evita errores de tecleo. */
  maxEntries: number;
  /** Servicios del catálogo que sugieren participaciones al técnico. */
  eligibleOfferingIds: string[];
  closedAt: string | null;
};

/** Tope absoluto por visita (cada sorteo fija el suyo, como máximo este). */
export const GIVEAWAY_ENTRIES_LIMIT = 100;

const ecuadorDay = (value: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Guayaquil' }).format(value);

/** Admite participaciones: no se cerró a mano y no pasó el día del sorteo (Ecuador). */
export const giveawayIsOpen = (
  g: { drawDate: string; closedAt: string | Date | null },
  now = new Date(),
) => !g.closedAt && ecuadorDay(now) <= g.drawDate;

/**
 * Participaciones sugeridas al técnico: la cantidad registrada de los servicios que el sorteo
 * cuenta. Es solo una sugerencia; el técnico confirma el número.
 */
export function suggestedGiveawayEntries(
  services: { offeringId: string | null; quantity: number }[],
  eligibleOfferingIds: string[],
) {
  return services
    .filter((s) => s.offeringId && eligibleOfferingIds.includes(s.offeringId))
    .reduce((total, s) => total + s.quantity, 0);
}

/** Cuerpo opcional de «completar visita». Sin cuerpo = no participa. */
export const completeAppointmentSchema = z
  .object({
    giveawayEntries: z.number().int().min(0).max(GIVEAWAY_ENTRIES_LIMIT).default(0),
  })
  .strict();

/** Nuevo sorteo (Administración). */
export const giveawayInputSchema = z
  .object({
    prize: z.string().trim().min(2, 'Escribe el premio').max(80),
    drawDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Elige el día del sorteo'),
    entryRule: z
      .string()
      .trim()
      .min(10, 'Explica cómo se participa (al menos 10 caracteres)')
      .max(300),
    maxEntries: z.number().int().min(1).max(GIVEAWAY_ENTRIES_LIMIT).default(20),
    eligibleOfferingIds: z.array(z.string().min(1).max(100)).max(50).default([]),
  })
  .strict();
export type GiveawayInput = z.infer<typeof giveawayInputSchema>;

/** Corrección de las participaciones de una visita (Administración). */
export const giveawayEntriesSchema = z
  .object({ giveawayEntries: z.number().int().min(0).max(GIVEAWAY_ENTRIES_LIMIT) })
  .strict();

/** «1 participación» / «3 participaciones». */
export const entriesLabel = (n: number) => (n === 1 ? '1 participación' : `${n} participaciones`);
