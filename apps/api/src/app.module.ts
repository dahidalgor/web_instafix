import { BookingAdminController } from './booking/booking-admin.controller';
import { EmailAdminController } from './auth/email-admin.controller';
import { SiteController } from './site/site.controller';
import { AnalyticsController } from './analytics/analytics.controller';
import { BookingController } from './booking/booking.controller';
import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ProviderErrorFilter } from './common/provider-error.filter';
import { ThrottlerModule } from '@nestjs/throttler';
import { ClientIpThrottlerGuard, throttlerOptions } from './security/rate-limits';
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
import { StaffController } from './staff/staff.controller';
import { TeamController } from './staff/team.controller';
import { PeopleAdminController } from './admin/people-admin.controller';
import { GiveawayAdminController } from './admin/giveaway-admin.controller';
import { PushController } from './notifications/staff/push.controller';

@Module({
  imports: [WhatsAppModule, ThrottlerModule.forRoot(throttlerOptions)],
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
    StaffController,
    TeamController,
    PeopleAdminController,
    GiveawayAdminController,
    PushController,
  ],
  providers: [
    VerificationService,
    NotificationWorker,
    { provide: APP_GUARD, useClass: ClientIpThrottlerGuard },
    { provide: APP_FILTER, useClass: ProviderErrorFilter },
  ],
})
export class AppModule {}
