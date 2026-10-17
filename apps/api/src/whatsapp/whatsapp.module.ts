import { Module } from '@nestjs/common';
import { WhatsAppAdminController } from './admin.controller';
import { WasapFlowClient } from './wasapflow.client';
import { WhatsAppService } from './whatsapp.service';
import { WhatsAppOnboardingService } from './onboarding.service';
import { WhatsAppWorker } from './worker';
import { BridgeWebhookWorker } from './bridge-webhooks';
import { WHATSAPP_OTP_PROVIDER, otpProviderFactory } from './otp.provider';

@Module({
  controllers: [WhatsAppAdminController],
  providers: [
    WasapFlowClient,
    WhatsAppService,
    WhatsAppOnboardingService,
    WhatsAppWorker,
    BridgeWebhookWorker,
    { provide: WHATSAPP_OTP_PROVIDER, useFactory: otpProviderFactory, inject: [WasapFlowClient] },
  ],
  exports: [WhatsAppService, WHATSAPP_OTP_PROVIDER],
})
export class WhatsAppModule {}
