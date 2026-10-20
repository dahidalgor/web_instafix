import { Inject, Injectable } from '@nestjs/common';
import type { Appointment } from '@prisma/client';
import { logEvent } from '../common/log-event';
import { db } from '../database/client';
import { ProviderError } from '../integrations/provider-error';
import { whatsappConfiguration } from './config';
import { messageVariables, templateFor, type MessageKind } from './messages';
import {
  WHATSAPP_PROVIDER,
  WhatsAppProviderError,
  type SentMessage,
  type WhatsAppProvider,
} from './provider';

/**
 * Avisos de citas por WhatsApp. Decide qué plantilla y qué datos; el proveedor decide cómo
 * se envían. Nunca construye payloads de un proveedor concreto.
 */
@Injectable()
export class WhatsAppService {
  constructor(@Inject(WHATSAPP_PROVIDER) private readonly provider: WhatsAppProvider) {}
  get providerName() {
    return this.provider.name;
  }

  async sendAppointmentMessage(appointment: Appointment, kind: MessageKind): Promise<SentMessage> {
    if (!whatsappConfiguration().enabled)
      throw new ProviderError('Envíos de WhatsApp desactivados', 'FAILED');
    if (!appointment.whatsappConsentAt)
      throw new ProviderError('Falta autorización del cliente', 'FAILED');
    const template = templateFor(kind);
    try {
      const sent = await this.provider.sendTemplate({
        to: appointment.contactPhone,
        template,
        variables: messageVariables(kind, appointment),
      });
      await db.whatsAppMessage.upsert({
        where: {
          accountId_providerMessageId: {
            accountId: sent.accountId,
            providerMessageId: sent.providerMessageId,
          },
        },
        update: {},
        create: {
          provider: this.provider.name,
          accountId: sent.accountId,
          providerMessageId: sent.providerMessageId,
          phone: appointment.contactPhone,
          type: 'template',
          text: sent.text,
          source: 'api',
          direction: 'outbound',
          occurredAt: new Date(),
          content: { template },
        },
      });
      logEvent('whatsapp.accepted', {
        provider: this.provider.name,
        operation: template,
        appointmentId: appointment.id,
        providerMessageId: sent.providerMessageId,
        status: 'ACCEPTED',
      });
      return sent;
    } catch (error) {
      logEvent(
        'whatsapp.send_failed',
        {
          provider: this.provider.name,
          operation: template,
          appointmentId: appointment.id,
          error: error instanceof WhatsAppProviderError ? error.code : 'UNKNOWN',
          reason: error instanceof Error ? error.message.slice(0, 300) : 'Error inesperado',
        },
        'warn',
      );
      throw error;
    }
  }

  /** Estado de la cuenta para Administración; nunca bloquea la página si el proveedor falla. */
  async accountStatus() {
    try {
      return { ...(await this.provider.accountStatus()), error: null };
    } catch (error) {
      return {
        provider: this.provider.name,
        number: null,
        templates: [],
        authenticationTemplate: null,
        error: error instanceof Error ? error.message : 'No se pudo consultar el proveedor',
      };
    }
  }
}
