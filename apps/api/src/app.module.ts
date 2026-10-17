import { BookingAdminController } from './booking/booking-admin.controller';
import { EmailAdminController } from './auth/email-admin.controller';
import { SiteController } from './site/site.controller';
import { AnalyticsController } from './analytics/analytics.controller';
import { BookingController } from './booking/booking.controller';
import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ProviderErrorFilter } from './common/provider-error.filter';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AccountController } from './account/account.controller';
import { SecurityController } from './account/security.controller';
import { VerificationService } from './auth/verification.service';
import { NotificationWorker } from './notifications/notification.service';
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
    BookingAdminController,
    EmailAdminController,
    SiteController,
    AnalyticsController,
    BookingController,
    AuthController,
    AccountController,
    SecurityController,
    CatalogController,
    AppointmentsController,
    JobsController,
    WarrantiesController,
    RequestsController,
    MediaController,
    HealthController,
    WebhooksController,
  ],
  providers: [
    VerificationService,
    NotificationWorker,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_FILTER, useClass: ProviderErrorFilter },
  ],
})
export class AppModule {}
