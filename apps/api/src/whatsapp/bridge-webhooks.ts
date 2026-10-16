import {
  BadRequestException,
  Injectable,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { normalizePhone } from '@instafix/contracts/src/phone';
import { db } from '../database/client';
import { connectedWaba } from './connection';
import { receiveCustomerMessage } from './inbound';
import { receiveDelivery } from './delivery';

const timestamp = z.number().int().nonnegative().max(8640000000000);
const short = z.string().max(300);
const location = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  name: z.string().max(200).optional(),
  address: z.string().max(500).optional(),
});
// Lista explícita: no persistimos raw completo, tokens ni campos de terceros desconocidos.
const envelope = z.object({
  event: short,
  waba_id: z.string().regex(/^\d+$/),
  timestamp,
  data: z.object({
    message_id: short.optional(),
    from: short.nullish(),
    recipient: short.nullish(),
    bsuid: short.nullish(),
    recipient_bsuid: short.nullish(),
    contact_bsuid: short.nullish(),
    contact_wa_id: short.nullish(),
    type: short.optional(),
    text: z.string().max(20000).nullish(),
    timestamp: timestamp.optional(),
    direction: z.enum(['inbound', 'outbound']).optional(),
    status: short.optional(),
    errors: z.array(z.object({ code: z.number() })).nullish(),
    raw: z
      .object({
        message: z
          .object({ location: location.optional(), context: z.object({ id: short }).optional() })
          .optional(),
      })
      .optional(),
    action: z.enum(['add', 'update', 'remove']).optional(),
    phone_number: short.optional(),
    full_name: z.string().max(300).optional(),
    version: z.number().optional(),
    phase: z.number().optional(),
    progress: z.number().optional(),
  }),
});
const supported = new Set([
  'message.received',
  'message.sent',
  'message.delivered',
  'message.read',
  'message.failed',
  'message.echo',
  'message.history',
  'contact.synced',
]);
type BridgeEvent = z.infer<typeof envelope>;
const phoneValue = (value?: string | null) =>
  value && /^\+?\d+$/.test(value)
    ? normalizePhone(value.startsWith('+') ? value : `+${value}`, 'EC')
    : null;

export async function receiveBridgeWebhook(body: unknown) {
  const parsed = envelope.safeParse(body);
  if (!parsed.success) throw new BadRequestException('Evento WasapFlow inválido');
  const event = parsed.data;
  if (!supported.has(event.event)) return { ignored: true };
  if (event.event.startsWith('message.') && !event.data.message_id)
    throw new BadRequestException('Falta message_id');
  const active = await connectedWaba();
  const connection = await db.whatsAppConnection.findUnique({ where: { id: 'main' } });
  const onboarding = connection?.stateExpiresAt && connection.stateExpiresAt > new Date();
  // El historial puede llegar antes del callback del popup. Se guarda, pero no se procesa
  // hasta verificar que esa WABA es la conexión Coexistence elegida por el administrador.
  if (active !== event.waba_id && !onboarding) return { ignored: true };
  if (process.env.WASAPFLOW_WABA_ID && process.env.WASAPFLOW_WABA_ID !== event.waba_id)
    return { ignored: true };
  const id = createHash('sha256').update(JSON.stringify(event)).digest('hex');
  await db.bridgeWebhook.upsert({
    where: { id },
    update: {},
    create: {
      id,
      wabaId: event.waba_id,
      event: event.event,
      payload: JSON.parse(JSON.stringify(event)),
    },
  });
  return { ok: true };
}

async function handleEvent(event: BridgeEvent) {
  const data = event.data;
  const occurredAt = new Date((data.timestamp ?? event.timestamp) * 1000);
  if (occurredAt.getTime() > Date.now() + 300000) throw new Error('Fecha futura inválida');
  if (event.event === 'contact.synced') {
    const phone = phoneValue(data.phone_number);
    if (!phone || !data.action) return;
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`contact:${event.waba_id}:${phone}`}))`;
      const existing = await tx.whatsAppContact.findUnique({
        where: { wabaId_phone: { wabaId: event.waba_id, phone } },
      });
      if (existing && existing.occurredAt >= occurredAt) return;
      const fields = { name: data.full_name, removed: data.action === 'remove', occurredAt };
      await tx.whatsAppContact.upsert({
        where: { wabaId_phone: { wabaId: event.waba_id, phone } },
        update: fields,
        create: { wabaId: event.waba_id, phone, ...fields },
      });
    });
    return;
  }
  const status = event.event.slice('message.'.length);
  if (['sent', 'delivered', 'read', 'failed'].includes(status)) {
    await receiveDelivery({
      id: data.message_id!,
      status,
      timestamp: String(data.timestamp ?? event.timestamp),
      errors: data.errors || undefined,
    });
    // Estados también pueden corresponder a un mensaje enviado fuera de Instafix.
    await db.whatsAppMessage.upsert({
      where: { wabaId_messageId: { wabaId: event.waba_id, messageId: data.message_id! } },
      update: {},
      create: {
        wabaId: event.waba_id,
        messageId: data.message_id!,
        phone: phoneValue(data.recipient),
        bsuid: data.recipient_bsuid,
        direction: 'outbound',
        source: 'api',
        type: 'unknown',
        occurredAt,
        content: {},
      },
    });
    return;
  }
  const live = event.event === 'message.received';
  const history = event.event === 'message.history';
  const phone = phoneValue(live ? data.from : history ? data.contact_wa_id : data.recipient);
  const fields = {
    phone,
    bsuid: (live ? data.bsuid : history ? data.contact_bsuid : data.recipient_bsuid) || null,
    direction: live ? 'inbound' : history ? data.direction || 'unknown' : 'outbound',
    source: live ? 'customer_live' : history ? 'history' : 'business_app',
    type: data.type || 'unknown',
    text: data.text || null,
    occurredAt,
    content: JSON.parse(JSON.stringify(data)),
  };
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`message:${event.waba_id}:${data.message_id}`}))`;
    const where = { wabaId_messageId: { wabaId: event.waba_id, messageId: data.message_id! } };
    const existing = await tx.whatsAppMessage.findUnique({ where });
    if (!existing || !history)
      await tx.whatsAppMessage.upsert({
        where,
        update: fields,
        create: { wabaId: event.waba_id, messageId: data.message_id!, ...fields },
      });
  });
  // La exclusión es deliberada: un eco o una ubicación histórica JAMÁS confirma una cita.
  if (live && phone)
    await receiveCustomerMessage({
      id: data.message_id!,
      from: phone.slice(1),
      timestamp: String(data.timestamp ?? event.timestamp),
      type: data.type || 'unknown',
      context: data.raw?.message?.context,
      location: data.raw?.message?.location,
    });
}

export async function processBridgeWebhook(id: string) {
  const active = await connectedWaba();
  if (!active) return;
  const claim = await db.bridgeWebhook.updateMany({
    where: { id, wabaId: active, status: 'PENDING', attempts: { lt: 5 } },
    data: { status: 'PROCESSING', processedAt: new Date(), attempts: { increment: 1 } },
  });
  if (!claim.count) return;
  try {
    const row = await db.bridgeWebhook.findUniqueOrThrow({ where: { id } });
    await handleEvent(envelope.parse(row.payload));
    await db.bridgeWebhook.update({
      where: { id },
      data: { status: 'DONE', processedAt: new Date(), payload: {} },
    });
  } catch {
    const row = await db.bridgeWebhook.findUniqueOrThrow({ where: { id } });
    await db.bridgeWebhook.update({
      where: { id },
      data: { status: row.attempts >= 5 ? 'REVIEW' : 'PENDING' },
    });
  }
}

@Injectable()
export class BridgeWebhookWorker implements OnModuleInit, OnModuleDestroy {
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
    if (this.running || !process.env.WASAPFLOW_WEBHOOK_SECRET) return;
    this.running = true;
    try {
      const wabaId = await connectedWaba();
      if (!wabaId) return;
      await db.bridgeWebhook.updateMany({
        where: {
          status: 'PROCESSING',
          attempts: { gte: 5 },
          processedAt: { lt: new Date(Date.now() - 300000) },
        },
        data: { status: 'REVIEW' },
      });
      await db.bridgeWebhook.updateMany({
        where: {
          status: 'PROCESSING',
          attempts: { lt: 5 },
          processedAt: { lt: new Date(Date.now() - 300000) },
        },
        data: { status: 'PENDING' },
      });
      const rows = await db.bridgeWebhook.findMany({
        where: { wabaId, status: 'PENDING', attempts: { lt: 5 } },
        orderBy: { createdAt: 'asc' },
        take: 50,
      });
      for (const row of rows) await processBridgeWebhook(row.id);
    } catch {
      console.error('No se pudo procesar la bandeja WasapFlow');
    } finally {
      this.running = false;
    }
  }
}
