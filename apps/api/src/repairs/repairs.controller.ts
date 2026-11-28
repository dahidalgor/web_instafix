import {
  repairAnswerSchema,
  repairDeliverSchema,
  repairIntakeSchema,
  repairQuoteSchema,
  repairStatusSchema,
} from '@instafix/contracts';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { authenticated, authenticatedStaff, checkOrigin } from '../auth/session';
import { RateLimit } from '../security/rate-limits';
import {
  adminAnswerRepair,
  adminRepairs,
  createRepair,
  customerAnswerRepair,
  customerRepairs,
  deliverRepair,
  quoteRepair,
  repairsForVisit,
  setRepairStatus,
} from './repairs.service';

const uuid = /^[0-9a-f-]{36}$/i;
const checkId = (id: string) => {
  if (!uuid.test(id)) throw new BadRequestException('Identificador no válido');
};
const parse = <T>(
  schema: {
    safeParse: (v: unknown) => {
      success: boolean;
      data?: T;
      error?: { issues: { message: string }[] };
    };
  },
  body: unknown,
) => {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success)
    throw new BadRequestException(parsed.error?.issues[0]?.message || 'Revisa los datos');
  return parsed.data as T;
};

/**
 * Trabajos de taller. El técnico los registra desde su visita; administración los lleva hasta
 * la entrega; el cliente los ve en Mi cuenta → En taller y responde el presupuesto.
 */
@Controller('api/v1')
export class RepairsController {
  // Técnico ---------------------------------------------------------------------------------
  @Post('staff/appointments/:id/repairs')
  @RateLimit('staff')
  async create(@Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    checkOrigin(req);
    checkId(id);
    return createRepair(await authenticatedStaff(req), id, parse(repairIntakeSchema, body));
  }

  @Get('staff/appointments/:id/repairs')
  @Header('Cache-Control', 'no-store')
  async forVisit(@Param('id') id: string, @Req() req: Request) {
    checkId(id);
    return repairsForVisit(await authenticatedStaff(req), id);
  }

  // Administración ----------------------------------------------------------------------------
  @Get('admin/repairs')
  @Header('Cache-Control', 'no-store')
  async list(@Req() req: Request, @Query('scope') scope = 'shop', @Query('q') q = '') {
    await authenticated(req, true);
    const s = scope === 'done' || scope === 'all' ? scope : 'shop';
    return adminRepairs(s, String(q).slice(0, 80));
  }

  @Post('admin/repairs/:id/status')
  @HttpCode(200)
  async status(@Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    checkOrigin(req);
    checkId(id);
    const admin = await authenticated(req, true);
    return setRepairStatus(admin.id, id, parse(repairStatusSchema, body).status);
  }

  @Post('admin/repairs/:id/quote')
  @HttpCode(200)
  async quote(@Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    checkOrigin(req);
    checkId(id);
    const admin = await authenticated(req, true);
    return quoteRepair(admin.id, id, parse(repairQuoteSchema, body));
  }

  /** El cliente respondió por otro medio (teléfono, en persona): administración lo registra. */
  @Post('admin/repairs/:id/answer')
  @HttpCode(200)
  async adminAnswer(@Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    checkOrigin(req);
    checkId(id);
    const admin = await authenticated(req, true);
    return adminAnswerRepair(admin.id, id, parse(repairAnswerSchema, body).answer);
  }

  @Post('admin/repairs/:id/deliver')
  @HttpCode(200)
  async deliver(@Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    checkOrigin(req);
    checkId(id);
    const admin = await authenticated(req, true);
    return deliverRepair(admin.id, id, parse(repairDeliverSchema, body));
  }

  // Cliente -------------------------------------------------------------------------------------
  @Get('my/repairs')
  @Header('Cache-Control', 'no-store')
  async mine(@Req() req: Request) {
    const user = await authenticated(req);
    return customerRepairs(user.id);
  }

  @Post('my/repairs/:id/answer')
  @HttpCode(200)
  @RateLimit('staff')
  async answer(@Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    checkOrigin(req);
    checkId(id);
    const user = await authenticated(req);
    return customerAnswerRepair(user.id, id, parse(repairAnswerSchema, body).answer);
  }
}
