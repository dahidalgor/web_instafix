import { Controller, Get, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { authenticated, checkOrigin } from './session';
import { mailStatus, verifyMailConnection } from './email';

@Controller('api/v1/admin/email')
export class EmailAdminController {
  @Get('status') async status(@Req() req: Request) {
    await authenticated(req, true);
    return mailStatus();
  }
  @Post('verify')
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  async verify(@Req() req: Request) {
    checkOrigin(req);
    await authenticated(req, true);
    return verifyMailConnection();
  }
}
