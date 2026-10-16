import { Controller, Post, Req, HttpCode, type RawBodyRequest } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import { receiveBridgeWebhook } from '../whatsapp/bridge-webhooks';
import { receiveCalWebhook } from './cal-webhook';
import { verifySignature } from './signature';

@Controller('api/v1/webhooks')
@SkipThrottle() // Firmas HMAC; los reintentos del proveedor no deben perderse por el límite de clientes.
export class WebhooksController {
  @Post('wasapflow') @HttpCode(200) whatsapp(@Req() req: RawBodyRequest<Request>) {
    verifySignature(
      req.rawBody,
      req.get('x-wasapflow-signature'),
      process.env.WASAPFLOW_WEBHOOK_SECRET,
      'sha256=',
    );
    return receiveBridgeWebhook(req.body);
  }
  @Post('cal') @HttpCode(200) cal(@Req() req: RawBodyRequest<Request>) {
    verifySignature(req.rawBody, req.get('x-cal-signature-256'), process.env.CAL_WEBHOOK_SECRET);
    return receiveCalWebhook(req.body);
  }
}
