import { ProviderError } from '../integrations/provider-error';

/**
 * Contrato neutral de WhatsApp. Instafix (avisos de citas, OTP, webhooks) solo conoce estos
 * tipos; el proveedor concreto (hoy Bird) traduce plantillas, errores y eventos.
 */

/** Plantillas de Instafix por su nombre lógico; el proveedor las resuelve a las suyas. */
export const whatsappTemplates = [
  'appointment_requested',
  'appointment_confirmed',
  'appointment_rescheduled',
  'appointment_cancelled',
  'appointment_reminder',
] as const;
export type WhatsAppTemplate = (typeof whatsappTemplates)[number];

/**
 * Variables con nombre que Instafix ofrece en cada aviso. Una plantilla puede usar cualquiera de
 * ellas ({{nombre}}, {{fecha}}…); si declara una que Instafix no ofrece, el envío se rechaza.
 */
export type TemplateVariables = Partial<
  Record<'nombre' | 'servicio' | 'fecha' | 'hora' | 'tecnico' | 'cuando', string>
>;

export type SentMessage = {
  /** Id del mensaje en el proveedor (p. ej. wam_… en Bird). */
  providerMessageId: string;
  /** Cuenta/número emisor tal como lo identifica el proveedor. */
  accountId: string;
  /** Texto final enviado, para el historial (sin códigos OTP). */
  text: string | null;
};

/** Estados normalizados. «Aceptado» no es «entregado»: llega por webhook. */
export type DeliveryStatus = 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';

/** Errores normalizados de cualquier proveedor. */
export type WhatsAppErrorCode =
  | 'CONFIG'
  | 'AUTH'
  | 'PERMISSION'
  | 'CHANNEL'
  | 'RECIPIENT'
  | 'TEMPLATE'
  | 'TEMPLATE_NOT_APPROVED'
  | 'BILLING'
  | 'RATE_LIMIT'
  | 'META_REJECTED'
  | 'PROVIDER_UNAVAILABLE'
  | 'NETWORK'
  | 'UNKNOWN';

/**
 * Error saneado: el mensaje es texto propio más el código del proveedor y el id de su petición;
 * nunca la clave, el teléfono completo ni la respuesta cruda.
 * - RETRY: seguro reintentar (no se envió nada).
 * - FAILED: definitivo hasta corregir la configuración.
 * - REVIEW: resultado incierto; no se reenvía solo para no duplicar.
 */
export class WhatsAppProviderError extends ProviderError {
  constructor(
    public code: WhatsAppErrorCode,
    message: string,
    disposition: 'RETRY' | 'FAILED' | 'REVIEW',
  ) {
    super(message, disposition);
  }
}

export type WhatsAppStatusEvent = {
  kind: 'STATUS';
  eventId: string;
  providerMessageId: string;
  status: DeliveryStatus;
  occurredAt: Date;
  error?: { code: string; metaCode?: string | null };
};
export type WhatsAppMessageEvent = {
  kind: 'MESSAGE';
  eventId: string;
  providerMessageId: string;
  accountId: string;
  /** customer_live: el cliente escribió ahora; business_app: eco de la app; history: sincronización. */
  source: 'customer_live' | 'business_app' | 'history';
  direction: 'inbound' | 'outbound';
  phone: string | null;
  bsuid: string | null;
  type: string;
  text: string | null;
  occurredAt: Date;
  inReplyTo: string | null;
  location?: {
    latitude?: number;
    longitude?: number;
    name?: string;
    address?: string;
    url?: string;
  };
  media?: { type: string; mimeType?: string; caption?: string; filename?: string };
};
export type WhatsAppWebhookEvent =
  WhatsAppStatusEvent | WhatsAppMessageEvent | { kind: 'IGNORED'; eventId: string; type: string };

export type WhatsAppAccountStatus = {
  provider: string;
  number: {
    phone: string | null;
    status: string;
    coexistence: boolean | null;
    quality: string | null;
    messagingLimit: string | null;
  } | null;
  templates: { name: string; status: string; language: string | null; problem: string | null }[];
  authenticationTemplate: { name: string; status: string } | null;
};

export interface WhatsAppProvider {
  readonly name: string;
  sendTemplate(input: {
    to: string;
    template: WhatsAppTemplate;
    variables: TemplateVariables;
  }): Promise<SentMessage>;
  sendAuthenticationCode(input: { to: string; code: string }): Promise<SentMessage>;
  /** Estado de la cuenta para Administración (número, Coexistence, plantillas). */
  accountStatus(): Promise<WhatsAppAccountStatus>;
  /** Verifica la firma sobre el cuerpo crudo y normaliza el evento. Lanza si la firma no vale. */
  parseWebhook(rawBody: string, headers: Record<string, string>): WhatsAppWebhookEvent;
}

export const WHATSAPP_PROVIDER = Symbol('WHATSAPP_PROVIDER');

export class WebhookSignatureError extends Error {}
