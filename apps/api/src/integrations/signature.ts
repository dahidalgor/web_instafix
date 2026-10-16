import { createHmac, timingSafeEqual } from 'node:crypto';
import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';

export function verifySignature(
  raw: Buffer | undefined,
  signature: string | undefined,
  secret: string | undefined,
  prefix = '',
) {
  if (!secret) throw new ServiceUnavailableException('Webhook no configurado');
  if (!raw || !signature?.startsWith(prefix)) throw new ForbiddenException('Firma inválida');
  const supplied = signature.slice(prefix.length);
  if (!/^[a-f0-9]{64}$/i.test(supplied)) throw new ForbiddenException('Firma inválida');
  const expected = createHmac('sha256', secret).update(raw).digest();
  if (!timingSafeEqual(expected, Buffer.from(supplied, 'hex')))
    throw new ForbiddenException('Firma inválida');
}
