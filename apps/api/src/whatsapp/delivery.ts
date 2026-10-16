import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { db } from '../database/client';

// WasapFlow puede notificar la entrega antes de que termine de guardarse el envío.
// Persistir primero el recibo permite conciliar ambos órdenes sin perder estados.
export async function deliveryState(tx: Prisma.TransactionClient, providerId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`delivery:${providerId}`}))`;
  const receipts = await tx.integrationEvent.findMany({
    where: { provider: 'WHATSAPP_STATUS', sourceId: providerId },
  });
  const ranks: Record<string, number> = { sent: 1, failed: 2, delivered: 3, read: 4 };
  const best = receipts.sort(
    (a, b) => (ranks[b.outcome.split(':')[0]] || 0) - (ranks[a.outcome.split(':')[0]] || 0),
  )[0];
  const [status, code] = best?.outcome.split(':') || [];
  return {
    deliveryStatus: status || null,
    lastError: status === 'failed' ? `WasapFlow: ${code || 'entrega fallida'}` : null,
  };
}

export async function receiveDelivery(status: {
  id: string;
  status: string;
  timestamp: string;
  errors?: { code: number }[];
}) {
  const occurredAt = new Date(Number(status.timestamp) * 1000);
  if (!Number.isFinite(occurredAt.getTime())) return;
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`delivery:${status.id}`}))`;
    const id =
      'wa-status:' +
      createHash('sha256')
        .update(`${status.id}:${status.status}:${status.timestamp}`)
        .digest('hex');
    await tx.integrationEvent.upsert({
      where: { id },
      update: {},
      create: {
        id,
        provider: 'WHATSAPP_STATUS',
        sourceId: status.id,
        occurredAt,
        outcome:
          status.status === 'failed' ? `failed:${status.errors?.[0]?.code || ''}` : status.status,
      },
    });
    const state = await deliveryState(tx, status.id);
    await tx.automationJob.updateMany({ where: { providerId: status.id }, data: state });
  });
}
