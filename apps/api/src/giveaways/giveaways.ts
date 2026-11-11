import type { Giveaway as GiveawayView } from '@instafix/contracts';
import type { Giveaway, Prisma } from '@prisma/client';
import { db } from '../database/client';
import { dayIn } from '../integrations/cal-client';

type Client = Prisma.TransactionClient | typeof db;

export const giveawayView = (g: Giveaway): GiveawayView => ({
  id: g.id,
  prize: g.prize,
  drawDate: g.drawDate,
  entryRule: g.entryRule,
  maxEntries: g.maxEntries,
  eligibleOfferingIds: g.eligibleOfferingIds,
  closedAt: g.closedAt?.toISOString() ?? null,
});

/**
 * El sorteo abierto, si hay uno: sin cerrar a mano y hasta el final del día del sorteo (fecha
 * de Ecuador). Administración solo permite uno abierto a la vez.
 */
export function openGiveaway(client: Client = db, now = new Date()) {
  return client.giveaway.findFirst({
    where: { closedAt: null, drawDate: { gte: dayIn(now) } },
    orderBy: { createdAt: 'desc' },
  });
}
