import { config } from 'dotenv';
import { resolve } from 'node:path';

// pnpm y Docker ejecutan la API desde apps/api. Las variables del servidor
// tienen prioridad sobre el archivo local, que nunca se incluye en la imagen.
config({ path: resolve(process.cwd(), '../../.env') });

export function allowedOrigins(): string[] {
  return (
    process.env.ALLOWED_ORIGINS ??
    'http://localhost:5173,http://127.0.0.1:5173,http://admin.localhost:5173'
  )
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

// En desarrollo Vite puede arrancar en otro puerto (5174…) o abrirse como 127.0.0.1.
const localDevOrigin = /^http:\/\/(localhost|127\.0\.0\.1|admin\.localhost)(:\d{1,5})?$/;

/** Fuera de producción se acepta cualquier origen local; en producción, solo la lista. */
export function isAllowedOrigin(origin: string | undefined): origin is string {
  if (!origin) return false;
  if (allowedOrigins().includes(origin)) return true;
  return process.env.NODE_ENV !== 'production' && localDevOrigin.test(origin);
}
