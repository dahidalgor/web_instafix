import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { db } from '../database/client';
import type { DeliveryStatus } from './provider';

const ranks: Record<string, number> = { SENT: 1, FAILED: 2, DELIVERED: 3, READ: 4 };

// El webhook de entrega puede llegar antes de que termine de guardarse el envío.
// Persistir primero el recibo permite conciliar ambos órdenes sin perder estados.
export async function deliveryState(tx: Prisma.TransactionClient, providerMessageId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`delivery:${providerMessageId}`}))`;
  const receipts = await tx.integrationEvent.findMany({
    where: { provider: 'WHATSAPP_STATUS', sourceId: providerMessageId },
  });
  const status = (outcome: string) => outcome.split(':')[0].toUpperCase();
  const best = receipts.sort(
    (a, b) => (ranks[status(b.outcome)] || 0) - (ranks[status(a.outcome)] || 0),
  )[0];
  const [, code, metaCode] = best?.outcome.split(':') || [];
  const deliveryStatus = best ? status(best.outcome) : null;
  return {
    deliveryStatus,
    lastError:
      deliveryStatus === 'FAILED'
        ? `WhatsApp no entregó el mensaje${code ? ` (${code}${metaCode ? `, Meta ${metaCode}` : ''})` : ''}`
        : null,
  };
}

/** Estado normalizado de un envío. Idempotente: el mismo estado repetido no cambia nada. */
export async function receiveDelivery(receipt: {
  providerMessageId: string;
  status: DeliveryStatus;
  occurredAt: Date;
  error?: { code: string; metaCode?: string | null };
}) {
  if (!Number.isFinite(receipt.occurredAt.getTime())) return;
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`delivery:${receipt.providerMessageId}`}))`;
    const id =
      'wa-status:' +
      createHash('sha256')
        .update(
          `${receipt.providerMessageId}:${receipt.status}:${receipt.occurredAt.toISOString()}`,
        )
        .digest('hex');
    const code = (value?: string | null) => (value || '').replace(/[^\w.-]/g, '').slice(0, 60);
    await tx.integrationEvent.upsert({
      where: { id },
      update: {},
      create: {
        id,
        provider: 'WHATSAPP_STATUS',
        sourceId: receipt.providerMessageId,
        occurredAt: receipt.occurredAt,
        outcome:
          receipt.status === 'FAILED'
            ? `FAILED:${code(receipt.error?.code)}:${code(receipt.error?.metaCode)}`
            : receipt.status,
      },
    });
    const state = await deliveryState(tx, receipt.providerMessageId);
    await tx.automationJob.updateMany({
      where: { providerMessageId: receipt.providerMessageId },
      data: state,
    });
  });
}
