import { Controller, Get } from '@nestjs/common';
import { calConfiguration, whatsappConfiguration } from '../whatsapp/config';
@Controller('api/v1')
export class HealthController {
  @Get('health') health() {
    const wa = whatsappConfiguration();
    return {
      status: 'ok',
      calendarConfigured: calConfiguration().configured,
      whatsappConfigured: wa.configured,
      whatsappEnabled: wa.enabled,
    };
  }
}
