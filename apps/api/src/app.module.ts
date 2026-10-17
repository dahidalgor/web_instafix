import { BookingAdminController } from './booking/booking-admin.controller';
import { EmailAdminController } from './auth/email-admin.controller';
import { SiteController } from './site/site.controller';
import { AnalyticsController } from './analytics/analytics.controller';
import { BookingController } from './booking/booking.controller';
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AccountController } from './account/account.controller';
import { AppointmentsController } from './appointments/appointments.controller';
import { MyAppointmentsController } from './appointments/my-appointments.controller';
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
  imports: [
    WhatsAppModule,
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 60000, limit: 20 }],
      // Solo las pruebas locales pueden desactivarlo; en producción siempre se aplica.
      skipIf: () =>
        process.env.NODE_ENV !== 'production' && process.env.INSTAFIX_TEST_DISABLE_THROTTLE === '1',
    }),
  ],
  controllers: [
    BookingAdminController,
    EmailAdminController,
    SiteController,
    AnalyticsController,
    BookingController,
    AuthController,
    AccountController,
    CatalogController,
    AppointmentsController,
    MyAppointmentsController,
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
