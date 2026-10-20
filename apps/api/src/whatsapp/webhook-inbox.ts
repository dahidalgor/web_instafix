import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { logEvent, logWorkerFailure } from '../common/log-event';
import { db } from '../database/client';
import { receiveDelivery } from './delivery';
import { receiveCustomerMessage } from './inbound';
import { locationFromText } from './maps-link';
import {
  WHATSAPP_PROVIDER,
  WebhookSignatureError,
  WhatsAppProviderError,
  type WhatsAppMessageEvent,
  type WhatsAppProvider,
  type WhatsAppWebhookEvent,
} from './provider';

/**
 * Recepción de webhooks: verificar la firma sobre el cuerpo crudo, guardar el evento normalizado
 * y responder enseguida. El negocio (estados, ubicación) lo ejecuta el worker de la bandeja.
 * El id de la fila es el id de entrega del proveedor: un reintento no se procesa dos veces.
 */
export async function receiveWhatsAppWebhook(
  provider: WhatsAppProvider,
  raw: Buffer | undefined,
  headers: Record<string, string>,
) {
  if (!raw?.length) throw new BadRequestException('Cuerpo vacío');
  let event: WhatsAppWebhookEvent;
  try {
    event = provider.parseWebhook(raw.toString('utf8'), headers);
  } catch (error) {
    if (error instanceof WebhookSignatureError) {
      logEvent(
        'whatsapp.webhook_rejected',
        { provider: provider.name, reason: error.message },
        'warn',
      );
      throw new ForbiddenException('Firma inválida');
    }
    if (error instanceof WhatsAppProviderError && error.code === 'CONFIG')
      throw new ServiceUnavailableException('Webhook no configurado');
    throw error;
  }
  if (event.kind === 'IGNORED') return { ignored: true };
  const id = `${provider.name}:${event.eventId}`.slice(0, 200);
  await db.whatsAppWebhook.upsert({
    where: { id },
    update: {},
    create: {
      id,
      provider: provider.name,
      accountId: event.kind === 'MESSAGE' ? event.accountId : null,
      event: event.kind,
      payload: JSON.parse(JSON.stringify(event)),
    },
  });
  return { ok: true };
}

async function handleEvent(event: WhatsAppWebhookEvent, provider: string) {
  if (event.kind === 'IGNORED') return;
  if (event.occurredAt.getTime() > Date.now() + 300000) throw new Error('Fecha futura inválida');
  if (event.kind === 'STATUS') {
    await receiveDelivery(event);
    return;
  }
  await recordMessage(event, provider);
  // Solo un mensaje nuevo del cliente puede aportar la ubicación: nunca un eco ni el historial.
  if (event.source !== 'customer_live' || !event.phone) return;
  // Ubicación nativa de WhatsApp, o un enlace de Google/Apple Maps o coordenadas en el texto.
  const location =
    event.location ?? (event.text ? await locationFromText(event.text) : null) ?? undefined;
  await receiveCustomerMessage({
    id: event.providerMessageId,
    from: event.phone.slice(1),
    timestamp: String(Math.floor(event.occurredAt.getTime() / 1000)),
    type: location ? 'location' : event.type,
    ...(event.inReplyTo ? { context: { id: event.inReplyTo } } : {}),
    ...(location ? { location } : {}),
  });
}

async function recordMessage(event: WhatsAppMessageEvent, provider: string) {
  const where = {
    accountId_providerMessageId: {
      accountId: event.accountId,
      providerMessageId: event.providerMessageId,
    },
  };
  const fields = {
    phone: event.phone,
    bsuid: event.bsuid,
    direction: event.direction,
    source: event.source,
    type: event.type,
    text: event.text,
    occurredAt: event.occurredAt,
    content: JSON.parse(
      JSON.stringify({
        ...(event.location ? { location: event.location } : {}),
        ...(event.media ? { media: event.media } : {}),
        ...(event.inReplyTo ? { inReplyTo: event.inReplyTo } : {}),
      }),
    ),
  };
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`message:${event.accountId}:${event.providerMessageId}`}))`;
    const existing = await tx.whatsAppMessage.findUnique({ where });
    // El historial sincronizado nunca sobrescribe un mensaje ya registrado.
    if (existing && event.source === 'history') return;
    await tx.whatsAppMessage.upsert({
      where,
      update: fields,
      create: {
        provider,
        accountId: event.accountId,
        providerMessageId: event.providerMessageId,
        ...fields,
      },
    });
  });
}

/** El payload guardado es JSON: las fechas vuelven como texto. */
function revive(payload: unknown): WhatsAppWebhookEvent {
  const event = payload as WhatsAppWebhookEvent & { occurredAt: string };
  return { ...event, occurredAt: new Date(event.occurredAt) } as WhatsAppWebhookEvent;
}

export async function processWhatsAppWebhook(id: string) {
  const claim = await db.whatsAppWebhook.updateMany({
    where: { id, status: 'PENDING', attempts: { lt: 5 } },
    data: { status: 'PROCESSING', processedAt: new Date(), attempts: { increment: 1 } },
  });
  if (!claim.count) return;
  try {
    const row = await db.whatsAppWebhook.findUniqueOrThrow({ where: { id } });
    await handleEvent(revive(row.payload), row.provider);
    // Hecho: no se conserva el contenido del evento en la bandeja.
    await db.whatsAppWebhook.update({
      where: { id },
      data: { status: 'DONE', processedAt: new Date(), payload: {} },
    });
  } catch (error) {
    const row = await db.whatsAppWebhook.findUniqueOrThrow({ where: { id } });
    logEvent(
      'whatsapp.webhook_failed',
      {
        provider: row.provider,
        event: row.event,
        attempts: row.attempts,
        reason: error instanceof Error ? error.message.slice(0, 200) : 'Error inesperado',
      },
      'warn',
    );
    await db.whatsAppWebhook.update({
      where: { id },
      data: { status: row.attempts >= 5 ? 'REVIEW' : 'PENDING' },
    });
  }
}

@Injectable()
export class WhatsAppWebhookWorker implements OnModuleInit, OnModuleDestroy {
  constructor(@Inject(WHATSAPP_PROVIDER) private readonly provider: WhatsAppProvider) {}
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  onModuleInit() {
    this.timer = setInterval(() => void this.tick(), 3000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const provider = this.provider.name;
      const stale = new Date(Date.now() - 300000);
      await db.whatsAppWebhook.updateMany({
        where: { provider, status: 'PROCESSING', attempts: { gte: 5 }, processedAt: { lt: stale } },
        data: { status: 'REVIEW' },
      });
      await db.whatsAppWebhook.updateMany({
        where: { provider, status: 'PROCESSING', attempts: { lt: 5 }, processedAt: { lt: stale } },
        data: { status: 'PENDING' },
      });
      const rows = await db.whatsAppWebhook.findMany({
        where: { provider, status: 'PENDING', attempts: { lt: 5 } },
        orderBy: { createdAt: 'asc' },
        take: 50,
        select: { id: true },
      });
      for (const row of rows) await processWhatsAppWebhook(row.id);
    } catch (error) {
      logWorkerFailure('whatsapp.webhook_inbox', error);
    } finally {
      this.running = false;
    }
  }
}
