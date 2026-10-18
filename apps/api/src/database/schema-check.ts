import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { logEvent } from '../common/log-event';
import { db } from './client';

const schemaPath = () => resolve(process.cwd(), '../../database/schema.prisma');
// Prisma reformatea el esquema al copiarlo: se comparan sin espacios ni saltos de línea.
const normalize = (text: string) => text.replace(/\s+/g, '');

/**
 * Comprobación al arrancar: un cliente Prisma generado con un esquema anterior o migraciones
 * sin aplicar producen errores engañosos (p. ej. «cuenta desactivada» o 500 en /auth/me).
 * Se avisa con la causa exacta y el comando que la corrige; no se ocultan los errores.
 */
export async function checkDatabaseSchema() {
  const problems: string[] = [];
  try {
    const require = createRequire(__filename);
    const generated = join(
      dirname(require.resolve('@prisma/client/package.json')),
      '..',
      '..',
      '.prisma',
      'client',
      'schema.prisma',
    );
    if (
      normalize(readFileSync(generated, 'utf8')) !== normalize(readFileSync(schemaPath(), 'utf8'))
    )
      problems.push(
        'El cliente Prisma no corresponde a database/schema.prisma: ejecuta «pnpm db:generate».',
      );
  } catch {
    // Sin acceso a los archivos (p. ej. imagen sin el esquema): se omite esta comprobación.
  }
  try {
    const folder = join(dirname(schemaPath()), 'migrations');
    const expected = readdirSync(folder, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    const applied = await db.$queryRaw<{ migration_name: string }[]>`
      SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
    const done = new Set(applied.map((row) => row.migration_name));
    const pending = expected.filter((name) => !done.has(name));
    if (pending.length)
      problems.push(
        `Migraciones pendientes (${pending.join(', ')}): ejecuta «pnpm --filter @instafix/api exec prisma migrate deploy --schema ../../database/schema.prisma».`,
      );
  } catch {
    problems.push(
      'No se pudo consultar la base de datos: revisa DATABASE_URL y que PostgreSQL esté encendido.',
    );
  }
  if (problems.length) logEvent('db.schema_mismatch', { problems }, 'warn');
  return problems;
}
