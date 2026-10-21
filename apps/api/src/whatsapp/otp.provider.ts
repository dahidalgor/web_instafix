import { ProviderError } from '../integrations/provider-error';
import type { WhatsAppProvider } from './provider';
import { whatsappSendingEnabled } from './budget';

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
  const missing = ['BIRD_API_KEY'].filter((key) => !process.env[key]?.trim());
  return {
    enabled: process.env.WHATSAPP_OTP_ENABLED === 'true',
    sendingEnabled: whatsappSendingEnabled(),
    configured: !missing.length,
    missing,
    // Plantilla de autenticación gestionada por Bird (sale desde un número de Bird).
    template: 'bird_otp',
    devConsole: devConsoleAllowed(),
  };
}

// Solo en desarrollo explícito: imprime el código en la consola local para probar sin Meta.
const devConsoleAllowed = () =>
  process.env.NODE_ENV === 'development' && process.env.WHATSAPP_OTP_PROVIDER === 'console';

export class WhatsAppCodeSender implements WhatsAppOtpProvider {
  constructor(private readonly provider: WhatsAppProvider) {}
  get name() {
    return this.provider.name;
  }
  async sendAuthenticationCode(to: string, code: string) {
    if (!otpConfiguration().enabled)
      throw new ProviderError(
        'Verificación por WhatsApp desactivada (WHATSAPP_OTP_ENABLED≠true)',
        'FAILED',
      );
    // Interruptor general de envíos: Bird no recibe ninguna llamada.
    if (!whatsappSendingEnabled())
      throw new ProviderError(
        'Envíos de WhatsApp desactivados (WHATSAPP_SENDING_ENABLED=false)',
        'FAILED',
      );
    const sent = await this.provider.sendAuthenticationCode({ to, code });
    return { messageId: sent.providerMessageId };
  }
}

export class ConsoleOtpProvider implements WhatsAppOtpProvider {
  readonly name = 'CONSOLE_DEV';
  async sendAuthenticationCode(to: string, code: string) {
    if (!devConsoleAllowed())
      throw new ProviderError('Proveedor de desarrollo no permitido', 'FAILED');
    console.log(`[desarrollo] OTP para ${to.slice(0, 4)}…${to.slice(-2)}: ${code}`);
    return { messageId: `dev-${Date.now()}` };
  }
}

export function otpProviderFactory(provider: WhatsAppProvider): WhatsAppOtpProvider {
  return devConsoleAllowed() ? new ConsoleOtpProvider() : new WhatsAppCodeSender(provider);
}
