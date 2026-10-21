import type { Prisma } from '@prisma/client';
import { logEvent } from '../common/log-event';
import { db } from '../database/client';

/** Acción administrativa sensible: quién, qué y sobre qué (sin datos personales en el log). */
export async function auditAdmin(
  actorId: string,
  action: string,
  target: string,
  detail: Prisma.InputJsonObject = {},
  client: Prisma.TransactionClient | typeof db = db,
) {
  await client.adminAction.create({ data: { actorId, action, target, detail } });
  logEvent('admin.action', { action, actorId });
}
