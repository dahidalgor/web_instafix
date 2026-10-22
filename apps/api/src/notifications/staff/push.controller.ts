import type { StaffPushPayload, StaffPushStatus } from '@instafix/contracts';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  Post,
  Put,
  Query,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Request } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { authenticated, checkOrigin } from '../../auth/session';
import { logEvent } from '../../common/log-event';
import { db } from '../../database/client';
import { RateLimit } from '../../security/rate-limits';
import { producedStaffNotifications, pushRoles, staffRecipientRules } from './staff-notifications';
import {
  endpointHash,
  isAllowedPushEndpoint,
  vapidConfig,
  WebPushChannel,
} from './web-push.channel';

/** Dispositivos activos por cuenta; al pasar el límite se desactiva el más antiguo. */
const MAX_DEVICES = 10;
const installationId = z.string().uuid();
const base64url = (min: number, max: number) =>
  z
    .string()
    .min(min)
    .max(max)
    .regex(/^[A-Za-z0-9_-]+={0,2}$/);
const subscribeSchema = z
  .object({
    installationId,
    subscription: z
      .object({
        endpoint: z.string().url().max(1000),
        expirationTime: z.number().nullable().optional(),
        // P-256 sin comprimir (65 bytes) y secreto de 16 bytes, en base64url.
        keys: z.object({ p256dh: base64url(80, 100), auth: base64url(16, 32) }).strict(),
      })
      .strict(),
  })
  .strict();
const unsubscribeSchema = z.object({ installationId }).strict();

/** Etiqueta legible del dispositivo a partir del navegador (sin versión ni datos únicos). */
export function deviceLabel(userAgent = '') {
  const device = /iPhone/.test(userAgent)
    ? 'iPhone'
    : /iPad/.test(userAgent)
      ? 'iPad'
      : /Android/.test(userAgent)
        ? 'Android'
        : /Macintosh/.test(userAgent)
          ? 'Mac'
          : /Windows/.test(userAgent)
            ? 'Windows'
            : 'Dispositivo';
  const browser = /Edg\//.test(userAgent)
    ? 'Edge'
    : /Firefox\//.test(userAgent)
      ? 'Firefox'
      : /Chrome\//.test(userAgent)
        ? 'Chrome'
        : /Safari\//.test(userAgent)
          ? 'Safari'
          : 'Navegador';
  return `${device} · ${browser}`;
}

/** Solo el equipo (ADMIN/TECHNICIAN) registra dispositivos; siempre los suyos. */
async function staffUser(req: Request) {
  const user = await authenticated(req);
  if (!pushRoles.includes(user.role)) throw new ForbiddenException('Acceso restringido');
  return user;
}

/**
 * Notificaciones push del equipo. El destinatario es siempre el usuario de la sesión: nunca un
 * id enviado por el cliente. No existe ningún endpoint para enviar avisos arbitrarios.
 */
@Controller('api/v1/staff/push')
export class PushController {
  @Get()
  @Header('Cache-Control', 'no-store')
  @RateLimit('staff')
  async status(
    @Req() req: Request,
    @Query('installationId') installation = '',
  ): Promise<StaffPushStatus> {
    const user = await staffUser(req);
    const config = vapidConfig();
    const parsed = installationId.safeParse(installation);
    const [device, activeDevices] = await Promise.all([
      parsed.success
        ? db.pushSubscription.findFirst({
            where: { userId: user.id, installationId: parsed.data },
            orderBy: [{ active: 'desc' }, { updatedAt: 'desc' }],
            select: {
              active: true,
              label: true,
              lastSuccessAt: true,
              failureReason: true,
            },
          })
        : null,
      db.pushSubscription.count({ where: { userId: user.id, active: true } }),
    ]);
    return {
      configured: config.configured,
      // La clave pública no es secreta; la privada nunca sale del servidor.
      publicKey: config.configured ? config.publicKey : null,
      device: device
        ? {
            active: device.active,
            label: device.label,
            lastSuccessAt: device.lastSuccessAt?.toISOString() ?? null,
            failureReason: device.failureReason,
          }
        : null,
      activeDevices,
      receivesNotifications: producedStaffNotifications.some((type) =>
        staffRecipientRules[type].includes(user.role),
      ),
    };
  }

  @Put('subscription')
  @RateLimit('push')
  async subscribe(@Body() body: unknown, @Req() req: Request) {
    checkOrigin(req);
    const user = await staffUser(req);
    if (!vapidConfig().configured)
      throw new ServiceUnavailableException(
        'Las notificaciones no están configuradas en el servidor (claves VAPID).',
      );
    const parsed = subscribeSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Suscripción no válida');
    const { subscription, installationId: installation } = parsed.data;
    if (!isAllowedPushEndpoint(subscription.endpoint))
      throw new BadRequestException('Servicio de notificaciones no admitido');
    const hash = endpointHash(subscription.endpoint);
    const label = deviceLabel(req.headers['user-agent']);
    await db.$transaction(async (tx) => {
      // Mismo navegador, suscripción nueva: la anterior de esta instalación deja de usarse.
      await tx.pushSubscription.updateMany({
        where: {
          userId: user.id,
          installationId: installation,
          endpointHash: { not: hash },
          active: true,
        },
        data: { active: false, failureReason: 'Sustituida por una suscripción nueva' },
      });
      // El navegador que posee el endpoint lo demuestra al enviarlo: si otra cuenta del equipo
      // lo usó antes en este dispositivo, pasa a la sesión actual (la anterior deja de recibir).
      await tx.pushSubscription.upsert({
        where: { endpointHash: hash },
        update: {
          userId: user.id,
          endpoint: subscription.endpoint,
          p256dh: subscription.keys.p256dh,
          auth: subscription.keys.auth,
          installationId: installation,
          label,
          active: true,
          failureReason: null,
        },
        create: {
          userId: user.id,
          endpointHash: hash,
          endpoint: subscription.endpoint,
          p256dh: subscription.keys.p256dh,
          auth: subscription.keys.auth,
          installationId: installation,
          label,
        },
      });
      const active = await tx.pushSubscription.findMany({
        where: { userId: user.id, active: true },
        orderBy: { updatedAt: 'desc' },
        select: { id: true },
      });
      if (active.length > MAX_DEVICES)
        await tx.pushSubscription.updateMany({
          where: { id: { in: active.slice(MAX_DEVICES).map((row) => row.id) } },
          data: { active: false, failureReason: 'Límite de dispositivos' },
        });
    });
    logEvent('push.subscribed', { userId: user.id, label });
    return { ok: true, label };
  }

  @Delete('subscription')
  @RateLimit('push')
  async unsubscribe(@Body() body: unknown, @Req() req: Request) {
    checkOrigin(req);
    const user = await staffUser(req);
    const parsed = unsubscribeSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Dispositivo no válido');
    // Solo dispositivos propios: el filtro por usuario impide tocar los de otra cuenta.
    const { count } = await db.pushSubscription.updateMany({
      where: { userId: user.id, installationId: parsed.data.installationId, active: true },
      data: { active: false, failureReason: 'Desactivado por el usuario' },
    });
    logEvent('push.unsubscribed', { userId: user.id, devices: count });
    return { ok: true, devices: count };
  }

  /** Aviso de prueba fijo, solo a los dispositivos del propio usuario. */
  @Post('test')
  @HttpCode(200)
  @RateLimit('communications')
  async test(@Req() req: Request) {
    checkOrigin(req);
    const user = await staffUser(req);
    const channel = new WebPushChannel();
    if (!channel.configured())
      throw new ServiceUnavailableException('Las notificaciones no están configuradas.');
    const payload: StaffPushPayload = {
      id: `test-${randomUUID()}`,
      type: 'TEST',
      title: 'Instafix',
      body: 'Notificación de prueba: este dispositivo recibe los avisos del panel.',
      url: '/',
      entityId: null,
      createdAt: new Date().toISOString(),
    };
    const outcome = await channel.deliver(user.id, payload);
    if (outcome.status === 'SENT') return { ok: true, delivered: outcome.delivered };
    throw new ServiceUnavailableException(
      outcome.status === 'NO_DEVICES'
        ? 'No hay dispositivos activos. Activa las notificaciones en este dispositivo.'
        : 'El servicio de notificaciones no aceptó el envío. Inténtalo más tarde.',
    );
  }
}
