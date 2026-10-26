import { visitSchema, type AnalyticsSummary } from '@instafix/contracts/src/site';
import { BadRequestException, Body, Controller, Get, Post, Req } from '@nestjs/common';
import { RateLimit } from '../security/rate-limits';
import type { Request } from 'express';
import { authenticated, checkOrigin } from '../auth/session';
import { db } from '../database/client';

@Controller('api/v1')
export class AnalyticsController {
  @Post('analytics/visits')
  @RateLimit('analytics')
  async visit(@Req() req: Request, @Body() body: unknown) {
    checkOrigin(req);
    const parsed = visitSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Métrica inválida');
    const { id, sessionId, page, activeSeconds } = parsed.data;
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${id}))`;
      const old = await tx.pageVisit.findUnique({ where: { id } });
      // El contador es acumulado: reintentos y beacons fuera de orden no duplican tiempo.
      if (!old) {
        await tx.pageVisit.create({ data: { id, sessionId, page, activeSeconds: 0 } });
      } else if (old.sessionId === sessionId && old.page === page) {
        const elapsed = Math.floor((Date.now() - old.createdAt.getTime()) / 1000) + 5;
        await tx.pageVisit.update({
          where: { id },
          data: {
            activeSeconds: Math.max(old.activeSeconds, Math.min(activeSeconds, elapsed)),
          },
        });
      }
      // Retención limitada; no se almacenan IP, agente de navegador ni identidad de cuenta.
      await tx.pageVisit.deleteMany({
        where: { createdAt: { lt: new Date(Date.now() - 90 * 86400000) } },
      });
    });
    return { ok: true };
  }

  @Get('admin/analytics') async summary(@Req() req: Request): Promise<AnalyticsSummary> {
    await authenticated(req, true);
    const where = { createdAt: { gte: new Date(Date.now() - 30 * 86400000) } };
    const [pages, sessions] = await Promise.all([
      db.pageVisit.groupBy({
        by: ['page'],
        where,
        _count: { id: true },
        _avg: { activeSeconds: true },
      }),
      db.pageVisit.groupBy({ by: ['sessionId'], where }),
    ]);
    return {
      days: 30,
      visits: pages.reduce((sum, p) => sum + p._count.id, 0),
      sessions: sessions.length,
      // De más a menos visitada.
      pages: pages
        .map((p) => ({
          page: p.page,
          visits: p._count.id,
          averageSeconds: Math.round(p._avg.activeSeconds ?? 0),
        }))
        .sort((a, b) => b.visits - a.visits || a.page.localeCompare(b.page)),
    };
  }
}
