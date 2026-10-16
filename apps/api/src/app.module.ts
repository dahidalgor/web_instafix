import { EmailAdminController } from './auth/email-admin.controller';
import { SiteController } from './site/site.controller';
import { AnalyticsController } from './analytics/analytics.controller';
import { BookingController } from './booking/booking.controller';
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AccountController } from './account/account.controller';
import { AppointmentsController } from './appointments/appointments.controller';
import { AuthController } from './auth/auth.controller';
import { CatalogController } from './catalog/catalog.controller';
import { HealthController } from './health/health.controller';
import { JobsController } from './jobs/jobs.controller';
import { MediaController } from './media/media.controller';
import { RequestsController } from './requests/requests.controller';
import { WarrantiesController } from './warranties/warranties.controller';
import { WebhooksController } from './integrations/webhooks.controller';
import { WhatsAppModule } from './whatsapp/whatsapp.module';

@Module({
  imports: [WhatsAppModule, ThrottlerModule.forRoot([{ ttl: 60000, limit: 20 }])],
  controllers: [
    EmailAdminController,
    SiteController,
    AnalyticsController,
    BookingController,
    AuthController,
    AccountController,
    CatalogController,
    AppointmentsController,
    JobsController,
    WarrantiesController,
    RequestsController,
    MediaController,
    HealthController,
    WebhooksController,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
