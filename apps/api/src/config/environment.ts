import { config } from 'dotenv';
import { resolve } from 'node:path';

// pnpm y Docker ejecutan la API desde apps/api. Las variables del servidor
// tienen prioridad sobre el archivo local, que nunca se incluye en la imagen.
config({ path: resolve(process.cwd(), '../../.env') });

export function allowedOrigins(): string[] {
  return (
    process.env.ALLOWED_ORIGINS ??
    'http://localhost:5173,http://127.0.0.1:5173,http://admin.localhost:5173'
  ).split(',');
}
