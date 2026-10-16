import { Module } from '@nestjs/common';
import { WhatsAppAdminController } from './admin.controller';
import { WasapFlowClient } from './wasapflow.client';
import { WhatsAppService } from './whatsapp.service';
import { WhatsAppOnboardingService } from './onboarding.service';
import { WhatsAppWorker } from './worker';
import { BridgeWebhookWorker } from './bridge-webhooks';

@Module({
  controllers: [WhatsAppAdminController],
  providers: [
    WasapFlowClient,
    WhatsAppService,
    WhatsAppOnboardingService,
    WhatsAppWorker,
    BridgeWebhookWorker,
  ],
  exports: [WhatsAppService],
})
export class WhatsAppModule {}
