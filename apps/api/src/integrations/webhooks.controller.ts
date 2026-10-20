import { Controller, HttpCode, Inject, Post, Req, type RawBodyRequest } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import { WHATSAPP_PROVIDER, type WhatsAppProvider } from '../whatsapp/provider';
import { receiveWhatsAppWebhook } from '../whatsapp/webhook-inbox';
import { receiveCalWebhook } from './cal-webhook';
import { verifySignature } from './signature';

@Controller('api/v1/webhooks')
@SkipThrottle() // Firmas verificadas; los reintentos del proveedor no deben perderse por el límite de clientes.
export class WebhooksController {
  constructor(@Inject(WHATSAPP_PROVIDER) private readonly whatsapp: WhatsAppProvider) {}
  /** Bird: Standard Webhooks (webhook-id, webhook-timestamp, webhook-signature). */
  @Post('bird') @HttpCode(200) bird(@Req() req: RawBodyRequest<Request>) {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers))
      if (typeof value === 'string') headers[key.toLowerCase()] = value;
    return receiveWhatsAppWebhook(this.whatsapp, req.rawBody, headers);
  }
  @Post('cal') @HttpCode(200) cal(@Req() req: RawBodyRequest<Request>) {
    verifySignature(req.rawBody, req.get('x-cal-signature-256'), process.env.CAL_WEBHOOK_SECRET);
    return receiveCalWebhook(req.body);
  }
}
