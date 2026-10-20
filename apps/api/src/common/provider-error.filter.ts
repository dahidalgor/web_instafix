import { ArgumentsHost, Catch, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { ProviderError } from '../integrations/provider-error';

/**
 * Un ProviderError que llega a la respuesta HTTP (p. ej. conectar WhatsApp desde
 * Administración) se devolvía como «Internal server error» y ocultaba la causa. Sus mensajes
 * son textos propios y errores de Bird/Meta ya saneados: nunca contienen claves.
 */
@Catch(ProviderError)
export class ProviderErrorFilter implements ExceptionFilter {
  catch(error: ProviderError, host: ArgumentsHost) {
    console.error(`Proveedor externo: ${error.message}`);
    const status = error.disposition === 'RETRY' ? 503 : 502;
    host
      .switchToHttp()
      .getResponse<Response>()
      .status(status)
      .json({ statusCode: status, code: 'PROVIDER_ERROR', message: error.message });
  }
}
