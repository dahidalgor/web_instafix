import { createHmac, randomBytes } from 'node:crypto';

// Firma Standard Webhooks, como la genera Bird.
export function signedWebhook(
  secret: string,
  body: unknown,
  id = `msg_${randomBytes(6).toString('hex')}`,
) {
  const raw = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const signature = createHmac('sha256', key).update(`${id}.${timestamp}.${raw}`).digest('base64');
  return {
    raw,
    headers: {
      'webhook-id': id,
      'webhook-timestamp': timestamp,
      'webhook-signature': `v1,${signature}`,
    },
  };
}
export const webhookSecret = `whsec_${Buffer.from('instafix-test-secret-0123456789ab').toString('base64')}`;
