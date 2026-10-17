import { Injectable } from '@nestjs/common';
import { ProviderError } from '../integrations/provider-error';
import { requireConnectedWaba } from './connection';
import { WasapFlowClient } from './wasapflow.client';

/**
 * Transporte de códigos. Generar y validar el OTP pertenece a Instafix (VerificationService);
 * el proveedor solo lo entrega. Cambiar de proveedor no toca la autenticación.
 */
export interface WhatsAppOtpProvider {
  readonly name: string;
  sendAuthenticationCode(to: string, code: string): Promise<{ messageId: string }>;
}
export const WHATSAPP_OTP_PROVIDER = Symbol('WHATSAPP_OTP_PROVIDER');

export function otpConfiguration() {
  const missing = ['WASAPFLOW_PARTNER_KEY', 'WHATSAPP_TEMPLATE_OTP'].filter(
    (key) => !process.env[key],
  );
  return {
    enabled: process.env.WHATSAPP_OTP_ENABLED === 'true',
    configured: !missing.length,
    missing,
    template: process.env.WHATSAPP_TEMPLATE_OTP || null,
    devConsole: devConsoleAllowed(),
  };
}

// Solo en desarrollo explícito: imprime el código en la consola local para probar sin Meta.
const devConsoleAllowed = () =>
  process.env.NODE_ENV === 'development' && process.env.WHATSAPP_OTP_PROVIDER === 'console';

@Injectable()
export class WasapFlowOtpProvider implements WhatsAppOtpProvider {
  readonly name = 'WASAPFLOW';
  constructor(private readonly bridge: WasapFlowClient) {}
  async sendAuthenticationCode(to: string, code: string) {
    const config = otpConfiguration();
    if (!config.enabled)
      throw new ProviderError('Verificación por WhatsApp desactivada', 'FAILED');
    if (!config.template) throw new ProviderError('Falta la plantilla OTP aprobada', 'FAILED');
    const wabaId = await requireConnectedWaba();
    const messageId = await this.bridge.sendAuthenticationTemplate(
      wabaId,
      to.replace(/^\+/, ''),
      config.template,
      process.env.WHATSAPP_TEMPLATE_LANGUAGE || 'es',
      code,
    );
    return { messageId };
  }
}

export class ConsoleOtpProvider implements WhatsAppOtpProvider {
  readonly name = 'CONSOLE_DEV';
  async sendAuthenticationCode(to: string, code: string) {
    if (!devConsoleAllowed()) throw new ProviderError('Proveedor de desarrollo no permitido', 'FAILED');
    console.log(`[desarrollo] OTP para ${to.slice(0, 4)}…${to.slice(-2)}: ${code}`);
    return { messageId: `dev-${Date.now()}` };
  }
}

export function otpProviderFactory(bridge: WasapFlowClient): WhatsAppOtpProvider {
  return devConsoleAllowed() ? new ConsoleOtpProvider() : new WasapFlowOtpProvider(bridge);
}
