import {
  BirdAPIError,
  BirdAuthError,
  BirdBadRequestError,
  BirdBillingError,
  BirdConnectionError,
  BirdNotFoundError,
  BirdPermissionError,
  BirdRateLimitError,
  BirdServiceUnavailableError,
  BirdTimeoutError,
  BirdValidationError,
  BirdWebhookVerificationError,
} from '@messagebird/sdk';
import { normalizePhone } from '@instafix/contracts/src/phone';
import {
  type DeliveryStatus,
  type SentMessage,
  type TemplateVariables,
  type WhatsAppAccountStatus,
  type WhatsAppMessageEvent,
  type WhatsAppProvider,
  type WhatsAppTemplate,
  type WhatsAppWebhookEvent,
  WebhookSignatureError,
  WhatsAppProviderError,
  whatsappTemplates,
} from '../provider';
import { BirdConfigError, birdClient, birdWebhookReceiver } from './bird.client';

/**
 * Plantillas lógicas de Instafix → plantillas de Bird. Los slugs se crean en Bird con estos
 * mismos nombres; el idioma y las variables se leen de la versión aprobada.
 */
const BIRD_TEMPLATES: Record<WhatsAppTemplate, string> = {
  appointment_requested: 'appointment_requested',
  appointment_confirmed: 'appointment_confirmed',
  appointment_rescheduled: 'appointment_rescheduled',
  appointment_cancelled: 'appointment_cancelled',
  appointment_reminder: 'appointment_reminder',
};
/**
 * Código de verificación: plantilla de autenticación gestionada por Bird (ya aprobada, sale desde
 * un número de Bird). Si Meta aprueba una propia, basta con cambiar este slug.
 */
const BIRD_OTP_TEMPLATE = 'bird_otp';
const BIRD_OTP_LANGUAGE = 'es';
const CATALOG_TTL = 10 * 60000;

type Catalog = {
  slug: string;
  status: string;
  language: string;
  /** Variables por componente con texto, en orden de aparición. */
  components: { type: string; text: string; variables: string[] }[];
  fetchedAt: number;
};

const variablePattern = /\{\{\s*([^}\s]+)\s*\}\}/g;
const mask = (phone: string) => `${phone.slice(0, 4)}…${phone.slice(-2)}`;

/** Traduce cualquier fallo del SDK a un error normalizado y seguro de mostrar. */
export function birdFailure(error: unknown, operation: string): WhatsAppProviderError {
  if (error instanceof WhatsAppProviderError) return error;
  if (error instanceof BirdConfigError)
    return new WhatsAppProviderError('CONFIG', error.message, 'FAILED');
  if (error instanceof BirdConnectionError)
    return new WhatsAppProviderError('NETWORK', `Bird no respondió (${operation})`, 'RETRY');
  if (error instanceof BirdTimeoutError)
    // Bird pudo haber aceptado el envío: no se reenvía a ciegas.
    return new WhatsAppProviderError(
      'NETWORK',
      `Tiempo agotado con Bird (${operation}); comprueba en Bird si el mensaje salió`,
      'REVIEW',
    );
  if (!(error instanceof BirdAPIError))
    return new WhatsAppProviderError(
      'UNKNOWN',
      `Error inesperado con Bird (${operation})`,
      'REVIEW',
    );
  const ref = `Bird ${error.statusCode} ${error.code}${error.requestId ? ` · ${error.requestId}` : ''}`;
  const detail = `${error.message}`.slice(0, 200);
  const param = `${error.param ?? ''}`;
  if (error instanceof BirdAuthError)
    return new WhatsAppProviderError(
      'AUTH',
      `API key de Bird inválida o revocada (${ref})`,
      'FAILED',
    );
  if (error instanceof BirdPermissionError)
    return new WhatsAppProviderError(
      'PERMISSION',
      `La API key de Bird no tiene permiso: ${detail} (${ref})`,
      'FAILED',
    );
  if (error instanceof BirdBillingError)
    return new WhatsAppProviderError('BILLING', `Bird: saldo o facturación (${ref})`, 'FAILED');
  if (error instanceof BirdRateLimitError)
    return new WhatsAppProviderError('RATE_LIMIT', `Bird: límite de envíos (${ref})`, 'RETRY');
  if (error instanceof BirdServiceUnavailableError)
    return new WhatsAppProviderError(
      'PROVIDER_UNAVAILABLE',
      `Bird no disponible (${ref})`,
      'RETRY',
    );
  if (error.statusCode >= 500)
    return new WhatsAppProviderError(
      'PROVIDER_UNAVAILABLE',
      `Error interno de Bird (${ref}); comprueba si el mensaje salió`,
      'REVIEW',
    );
  if (
    error instanceof BirdValidationError ||
    error instanceof BirdBadRequestError ||
    error instanceof BirdNotFoundError
  ) {
    const code = /^to\b|recipient/.test(param)
      ? 'RECIPIENT'
      : /^from\b|number/.test(param)
        ? 'CHANNEL'
        : /template/.test(param) || /template/i.test(detail)
          ? 'TEMPLATE'
          : error instanceof BirdNotFoundError
            ? 'CHANNEL'
            : 'UNKNOWN';
    return new WhatsAppProviderError(
      code,
      `Bird rechazó la petición: ${detail} (${ref})`,
      'FAILED',
    );
  }
  return new WhatsAppProviderError('UNKNOWN', `Bird: ${detail} (${ref})`, 'FAILED');
}

export class BirdWhatsAppProvider implements WhatsAppProvider {
  readonly name = 'BIRD';
  private catalog = new Map<string, Catalog>();

  /** Número emisor de Instafix (E.164), conectado en Bird con Coexistence. */
  private sender() {
    const from = normalizePhone(process.env.WHATSAPP_BUSINESS_PHONE || '', 'EC');
    if (!from)
      throw new WhatsAppProviderError(
        'CONFIG',
        'Falta WHATSAPP_BUSINESS_PHONE (número de Instafix conectado en Bird)',
        'FAILED',
      );
    return from;
  }

  private async template(slug: string, refresh = false): Promise<Catalog> {
    const cached = this.catalog.get(slug);
    if (cached && !refresh && Date.now() - cached.fetchedAt < CATALOG_TTL) return cached;
    const bird = birdClient();
    const template = await bird.whatsapp.templates.get(slug);
    const language = template.default_language;
    const components: Catalog['components'] = [];
    if (template.live_version_id) {
      const content = await bird.whatsapp.templates.versions.languages.get(
        slug,
        template.live_version_id,
        language,
      );
      for (const component of content.components)
        if (component.text)
          components.push({
            type: component.type.toLowerCase(),
            text: component.text,
            variables: [...component.text.matchAll(variablePattern)].map((m) => m[1]),
          });
    }
    const entry: Catalog = {
      slug,
      status: template.live_version_id ? template.status : 'pending',
      language,
      components,
      fetchedAt: Date.now(),
    };
    this.catalog.set(slug, entry);
    return entry;
  }

  async sendTemplate(input: {
    to: string;
    template: WhatsAppTemplate;
    variables: TemplateVariables;
  }): Promise<SentMessage> {
    const slug = BIRD_TEMPLATES[input.template];
    const from = this.sender();
    try {
      const template = await this.template(slug);
      if (template.status !== 'active')
        throw new WhatsAppProviderError(
          'TEMPLATE_NOT_APPROVED',
          `La plantilla «${slug}» no está aprobada en Bird (${template.status})`,
          'FAILED',
        );
      const values = input.variables as Record<string, string | undefined>;
      const components = [];
      let text = '';
      for (const component of template.components) {
        const missing = component.variables.filter((name) => !values[name]);
        if (component.variables.some((name) => /^\d+$/.test(name)) || missing.length)
          throw new WhatsAppProviderError(
            'TEMPLATE',
            `La plantilla «${slug}» usa variables que Instafix no ofrece (${(missing.length ? missing : component.variables).join(', ')}). Usa solo {{nombre}}, {{servicio}}, {{fecha}}, {{hora}}, {{tecnico}} o {{cuando}}.`,
            'FAILED',
          );
        if (component.variables.length)
          components.push({
            type: component.type,
            parameters: component.variables.map((name) => ({
              type: 'text',
              name,
              text: values[name]!,
            })),
          });
        if (component.type === 'body')
          text = component.text.replace(variablePattern, (_, name) => values[name] ?? '');
      }
      const sent = await birdClient().whatsapp.send({
        to: input.to,
        from,
        template: {
          slug,
          language: template.language,
          ...(components.length ? { components } : {}),
        },
      } as never);
      return { providerMessageId: sent.id, accountId: from, text: text || null };
    } catch (error) {
      const failure = birdFailure(error, `plantilla ${slug}`);
      // Una plantilla editada en Bird cambia sus variables: se vuelve a leer en el próximo envío.
      if (['TEMPLATE', 'TEMPLATE_NOT_APPROVED'].includes(failure.code)) this.catalog.delete(slug);
      throw failure;
    }
  }

  async sendAuthenticationCode(input: { to: string; code: string }): Promise<SentMessage> {
    try {
      // Plantilla gestionada por Bird: no lleva «from» (sale desde un número de Bird).
      const sent = await birdClient().whatsapp.send({
        to: input.to,
        template: {
          slug: BIRD_OTP_TEMPLATE,
          language: BIRD_OTP_LANGUAGE,
          components: [
            { type: 'body', parameters: [{ type: 'text', text: input.code }] },
            { type: 'button', parameters: [{ type: 'text', text: input.code }] },
          ],
        },
      } as never);
      return { providerMessageId: sent.id, accountId: BIRD_OTP_TEMPLATE, text: null };
    } catch (error) {
      throw birdFailure(error, `código de verificación a ${mask(input.to)}`);
    }
  }

  async accountStatus(): Promise<WhatsAppAccountStatus> {
    const bird = birdClient();
    const wanted = normalizePhone(process.env.WHATSAPP_BUSINESS_PHONE || '', 'EC');
    try {
      let number: WhatsAppAccountStatus['number'] = null;
      for await (const n of bird.whatsapp.numbers.list())
        if (n.scope === 'workspace' && n.phone_number && n.phone_number === wanted)
          number = {
            phone: n.phone_number,
            status: n.status,
            coexistence: n.is_on_business_app ?? null,
            quality: n.quality_rating ?? null,
            messagingLimit: n.messaging_limit ?? null,
          };
      const templates = [];
      for (const name of whatsappTemplates) {
        const slug = BIRD_TEMPLATES[name];
        try {
          const t = await this.template(slug, true);
          const offered = ['nombre', 'servicio', 'fecha', 'hora', 'tecnico', 'cuando'];
          const unknown = t.components
            .flatMap((c) => c.variables)
            .filter((v) => !offered.includes(v));
          templates.push({
            name: slug,
            status: t.status,
            language: t.language,
            problem: unknown.length ? `variables no reconocidas: ${unknown.join(', ')}` : null,
          });
        } catch (error) {
          const failure = birdFailure(error, `plantilla ${slug}`);
          templates.push({
            name: slug,
            status: error instanceof BirdNotFoundError ? 'missing' : 'error',
            language: null,
            problem: failure.message,
          });
        }
      }
      let authenticationTemplate: WhatsAppAccountStatus['authenticationTemplate'] = null;
      try {
        const otp = await bird.whatsapp.templates.get(BIRD_OTP_TEMPLATE);
        authenticationTemplate = { name: BIRD_OTP_TEMPLATE, status: otp.status };
      } catch {
        authenticationTemplate = { name: BIRD_OTP_TEMPLATE, status: 'missing' };
      }
      return { provider: this.name, number, templates, authenticationTemplate };
    } catch (error) {
      throw birdFailure(error, 'estado de la cuenta');
    }
  }

  parseWebhook(rawBody: string, headers: Record<string, string>): WhatsAppWebhookEvent {
    const secret = process.env.BIRD_WEBHOOK_SECRET?.trim();
    if (!secret) throw new WhatsAppProviderError('CONFIG', 'Falta BIRD_WEBHOOK_SECRET', 'FAILED');
    let event: any;
    try {
      event = birdWebhookReceiver(secret).webhooks.unwrap(rawBody, headers);
    } catch (error) {
      if (error instanceof BirdWebhookVerificationError)
        throw new WebhookSignatureError('Firma de Bird inválida');
      throw error;
    }
    // Bird reintenta con el mismo webhook-id: es la clave de idempotencia.
    const eventId = headers['webhook-id'];
    if (!eventId) throw new WebhookSignatureError('Falta webhook-id');
    const occurredAt = new Date(event.timestamp);
    const data = event.data ?? {};
    const statuses: Record<string, DeliveryStatus> = {
      'whatsapp.sent': 'SENT',
      'whatsapp.delivered': 'DELIVERED',
      'whatsapp.read': 'READ',
      'whatsapp.failed': 'FAILED',
      'whatsapp.rejected': 'FAILED',
    };
    if (!Number.isFinite(occurredAt.getTime()) || typeof data.whatsapp_id !== 'string')
      return { kind: 'IGNORED', eventId, type: String(event.type) };
    if (statuses[event.type])
      return {
        kind: 'STATUS',
        eventId,
        providerMessageId: data.whatsapp_id,
        status: statuses[event.type],
        occurredAt,
        ...(data.error
          ? {
              error: {
                code: String(data.error.code),
                metaCode: data.error.meta_error_code ?? null,
              },
            }
          : {}),
      };
    if (event.type !== 'whatsapp.received')
      return { kind: 'IGNORED', eventId, type: String(event.type) };
    return { ...inboundMessage(data, occurredAt), eventId };
  }
}

const contentTypes = [
  'text',
  'image',
  'video',
  'audio',
  'sticker',
  'document',
  'location',
  'contact_cards',
  'interactive_reply',
  'unsupported',
] as const;

/** Mensaje entrante o eco: solo los campos que Instafix usa, nunca el evento completo. */
function inboundMessage(data: any, occurredAt: Date): Omit<WhatsAppMessageEvent, 'eventId'> {
  const inbound = data.direction === 'inbound';
  const contact = (inbound ? data.from : data.to) ?? {};
  const business = (inbound ? data.to : data.from) ?? {};
  const source: WhatsAppMessageEvent['source'] =
    data.origin === 'history_sync'
      ? 'history'
      : data.origin === 'business_app_echo' || !inbound
        ? 'business_app'
        : 'customer_live';
  const type = contentTypes.find((key) => data[key]) ?? 'unknown';
  const media = ['image', 'video', 'audio', 'sticker', 'document'].includes(type)
    ? {
        type,
        ...(data[type].mime_type ? { mimeType: String(data[type].mime_type) } : {}),
        ...(data[type].caption ? { caption: String(data[type].caption).slice(0, 1000) } : {}),
        ...(data[type].filename ? { filename: String(data[type].filename).slice(0, 200) } : {}),
      }
    : undefined;
  // Ubicación nativa (WhatsAppLocation de Bird: latitude, longitude, name?, address?, url?).
  // Las coordenadas se pasan tal cual: la validación de rango la hace inbound.ts, que rechaza
  // las inválidas sin modificar ninguna cita.
  const raw =
    type === 'location' && data.location && typeof data.location === 'object'
      ? data.location
      : null;
  const location = raw
    ? {
        ...(raw.latitude !== undefined ? { latitude: Number(raw.latitude) } : {}),
        ...(raw.longitude !== undefined ? { longitude: Number(raw.longitude) } : {}),
        ...(raw.name ? { name: String(raw.name).slice(0, 200) } : {}),
        ...(raw.address ? { address: String(raw.address).slice(0, 500) } : {}),
        ...(typeof raw.url === 'string' && /^https:\/\//.test(raw.url)
          ? { url: raw.url.slice(0, 500) }
          : {}),
      }
    : undefined;
  const text =
    data.text?.body ??
    data.interactive_reply?.button?.text ??
    data.interactive_reply?.list?.text ??
    media?.caption ??
    null;
  return {
    kind: 'MESSAGE',
    providerMessageId: data.whatsapp_id,
    accountId: business.phone_number ?? 'bird',
    source,
    direction: inbound ? 'inbound' : 'outbound',
    phone: contact.phone_number ? normalizePhone(contact.phone_number, 'EC') : null,
    bsuid: contact.bsuid ?? null,
    type,
    text: typeof text === 'string' ? text.slice(0, 4096) : null,
    occurredAt,
    inReplyTo: data.in_reply_to_message_id ?? null,
    ...(location ? { location } : {}),
    ...(media ? { media } : {}),
  };
}
