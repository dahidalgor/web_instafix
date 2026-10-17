import { Injectable } from '@nestjs/common';
import type { Appointment } from '@prisma/client';
import { db } from '../database/client';
import { ProviderError } from '../integrations/provider-error';
import { requireConnectedWaba } from './connection';
import { messageContent, templateFor, type MessageKind } from './messages';
import { WasapFlowClient } from './wasapflow.client';

@Injectable()
export class WhatsAppService {
  constructor(private readonly bridge: WasapFlowClient) {}
  private async sendingWaba() {
    if (process.env.WHATSAPP_ENABLED !== 'true')
      throw new ProviderError('Envíos de WhatsApp desactivados', 'FAILED');
    return requireConnectedWaba();
  }
  async sendAppointmentMessage(appointment: Appointment, kind: MessageKind) {
    if (!appointment.whatsappConsentAt)
      throw new ProviderError('Falta autorización del cliente', 'FAILED');
    const wabaId = await this.sendingWaba();
    const content = messageContent(kind, appointment);
    const template = templateFor(kind);
    if (!template) throw new ProviderError(`Falta plantilla ${kind}`, 'FAILED');
    // Conservamos los cuatro flujos como templates: pueden iniciar conversación fuera de 24 h.
    const messageId = await this.bridge.sendTemplate(
      wabaId,
      appointment.contactPhone.replace(/^\+/, ''),
      template,
      process.env.WHATSAPP_TEMPLATE_LANGUAGE || 'es',
      content.params,
    );
    await this.recordOutbound(
      wabaId,
      messageId,
      appointment.contactPhone,
      'template',
      content.text,
    );
    return messageId;
  }
  // Solo respuestas a mensajes nuevos del cliente abren la ventana; ni echoes ni historial.
  async replyText(phone: string, text: string) {
    const wabaId = await this.sendingWaba();
    const last = await db.whatsAppMessage.findFirst({
      where: {
        wabaId,
        phone,
        source: 'customer_live',
        direction: 'inbound',
        occurredAt: { gt: new Date(Date.now() - 86400000), lte: new Date() },
      },
      orderBy: { occurredAt: 'desc' },
    });
    if (!last)
      throw new ProviderError(
        'Fuera de la ventana de 24 horas: utiliza una plantilla aprobada',
        'FAILED',
      );
    if (!text.trim() || text.length > 4096) throw new ProviderError('Texto inválido', 'FAILED');
    const messageId = await this.bridge.sendText(wabaId, phone.replace(/^\+/, ''), text);
    await this.recordOutbound(wabaId, messageId, phone, 'text', text);
    return messageId;
  }
  private async recordOutbound(
    wabaId: string,
    messageId: string,
    phone: string,
    type: string,
    text: string,
  ) {
    await db.whatsAppMessage.upsert({
      where: { wabaId_messageId: { wabaId, messageId } },
      update: { phone, type, text, source: 'api', direction: 'outbound' },
      create: {
        wabaId,
        messageId,
        phone,
        type,
        text,
        source: 'api',
        direction: 'outbound',
        occurredAt: new Date(),
        content: {},
      },
    });
  }
}
