import { requestSchema } from '@instafix/contracts';
export function parseRequest(value: unknown) {
  return requestSchema.safeParse(value);
}
export function expiration(now: Date) {
  return new Date(now.getTime() + 30 * 60 * 1000);
}
