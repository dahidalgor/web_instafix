import { helpRequestSchema } from '@instafix/contracts';
import { normalizePhone } from '@instafix/contracts/src/phone';
import {
  BadRequestException,
  Body,
  Controller,
  Post,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { db } from '../database/client';
import { publishedOffering } from '../catalog/published';
import { expiration, parseRequest } from './request-policy';
@Controller('api/v1')
export class RequestsController {
  @Post('help-requests') async help(@Body() body: unknown) {
    const parsed = helpRequestSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    if (!normalizePhone(parsed.data.phone, 'EC')) throw new BadRequestException('Número no válido');
    const { consent, ...input } = parsed.data;
    try {
      const record = await db.helpRequest.create({
        data: { ...input, reference: randomUUID(), consentAt: new Date() },
      });
      return { reference: record.reference, status: record.status };
    } catch {
      throw new ServiceUnavailableException('No pudimos guardar la consulta');
    }
  }
  @Post('requests') async create(@Body() body: unknown) {
    const result = parseRequest(body);
    if (!result.success) throw new BadRequestException(result.error.flatten());
    const input = result.data;
    const offer = await db.offering.findFirst({
      where: { ...publishedOffering, id: input.offeringId },
    });
    if (!offer || offer.availability !== 'AVAILABLE')
      throw new BadRequestException('Servicio no disponible');
    const now = new Date();
    // An unverified phone never claims or merges an existing customer history.
    const record = await db.serviceRequest.create({
      data: {
        reference: randomUUID(),
        customer: { create: { name: input.name, phone: input.phone } },
        offering: { connect: { id: offer.id } },
        problem: input.problem,
        phoneSnapshot: input.phone,
        priceMinor: offer.priceMinor,
        currency: offer.currency,
        consentAt: now,
        expiresAt: expiration(now),
      },
    });
    return {
      reference: record.reference,
      status: record.status,
      expiresAt: record.expiresAt.toISOString(),
    };
  }
}
