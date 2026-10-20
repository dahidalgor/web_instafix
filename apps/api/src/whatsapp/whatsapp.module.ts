import { Module } from '@nestjs/common';
import { WhatsAppAdminController } from './admin.controller';
import { BirdWhatsAppProvider } from './bird/bird.provider';
import { WHATSAPP_OTP_PROVIDER, otpProviderFactory } from './otp.provider';
import { WHATSAPP_PROVIDER } from './provider';
import { WhatsAppWebhookWorker } from './webhook-inbox';
import { WhatsAppService } from './whatsapp.service';
import { WhatsAppWorker } from './worker';

@Module({
  controllers: [WhatsAppAdminController],
  providers: [
    // Único lugar donde se elige el proveedor de WhatsApp.
    { provide: WHATSAPP_PROVIDER, useClass: BirdWhatsAppProvider },
    WhatsAppService,
    WhatsAppWorker,
    WhatsAppWebhookWorker,
    { provide: WHATSAPP_OTP_PROVIDER, useFactory: otpProviderFactory, inject: [WHATSAPP_PROVIDER] },
  ],
  exports: [WhatsAppService, WHATSAPP_OTP_PROVIDER, WHATSAPP_PROVIDER],
})
export class WhatsAppModule {}
