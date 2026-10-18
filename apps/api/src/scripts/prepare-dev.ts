import { execFileSync } from 'node:child_process';
import '../config/environment';

/**
 * Antes de `pnpm dev`: aplica las migraciones pendientes a la base local y regenera el cliente
 * Prisma. Así, traer commits con cambios de esquema no deja la web local con errores 500.
 * Solo usa `migrate deploy` (nunca borra datos ni reinicia la base).
 */
const schema = ['--schema', '../../database/schema.prisma'];
const prisma = (...args: string[]) =>
  execFileSync('prisma', [...args, ...schema], { stdio: 'inherit', env: process.env });

if (!process.env.DATABASE_URL) {
  console.error('Falta DATABASE_URL en el .env de la raíz del proyecto.');
  process.exit(1);
}
try {
  prisma('migrate', 'deploy');
} catch {
  console.error(
    '\nNo se pudieron aplicar las migraciones. Revisa que PostgreSQL esté encendido y DATABASE_URL.',
  );
  process.exit(1);
}
prisma('generate');
