import { BadRequestException, Injectable, Inject } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { db } from '../database/client';
import { WasapFlowClient } from './wasapflow.client';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
@Injectable()
export class WhatsAppOnboardingService {
  constructor(@Inject(WasapFlowClient) private readonly bridge: WasapFlowClient) {}
  async start(userId: string) {
    const state = randomBytes(32).toString('hex');
    const session = await this.bridge.createConnectSession(state);
    // Solo el hash se guarda; una segunda sesión invalida el resultado de la anterior.
    const fields = {
      stateHash: hash(state),
      stateUserId: userId,
      stateExpiresAt: new Date(Date.now() + (session.expires_in + 1800) * 1000),
    };
    await db.whatsAppConnection.upsert({
      where: { id: 'main' },
      create: { id: 'main', ...fields },
      update: fields,
    });
    return { connect_url: session.connect_url, expires_in: session.expires_in, state };
  }
  async complete(userId: string, body: unknown) {
    const parsed = z
      .object({
        state: z.string().length(64),
        waba_id: z.string().regex(/^\d+$/),
        connection_mode: z.literal('coexistence'),
      })
      .safeParse(body);
    if (!parsed.success)
      throw new BadRequestException('Solo se admite una conexión Coexistence válida');
    const data = parsed.data;
    const pending = await db.whatsAppConnection.findUnique({ where: { id: 'main' } });
    if (
      !pending ||
      pending.stateUserId !== userId ||
      pending.stateHash !== hash(data.state) ||
      !pending.stateExpiresAt ||
      pending.stateExpiresAt <= new Date()
    )
      throw new BadRequestException('La sesión de conexión caducó o no pertenece a esta cuenta');
    if (
      (pending.wabaId && pending.wabaId !== data.waba_id) ||
      (process.env.WASAPFLOW_WABA_ID && process.env.WASAPFLOW_WABA_ID !== data.waba_id)
    )
      throw new BadRequestException('La WABA no coincide con la conexión de Instafix');
    await this.bridge.verifyClient(data.waba_id);
    const result = await db.whatsAppConnection.updateMany({
      where: {
        id: 'main',
        stateHash: pending.stateHash,
        stateUserId: userId,
        stateExpiresAt: { gt: new Date() },
      },
      data: {
        wabaId: data.waba_id,
        connectionMode: 'coexistence',
        connectedAt: new Date(),
        stateHash: null,
        stateUserId: null,
        stateExpiresAt: null,
      },
    });
    if (!result.count) throw new BadRequestException('La sesión de conexión ya fue utilizada');
    return { connected: true, connectionMode: 'coexistence' };
  }
}
