/**
 * Registro estructurado (una línea JSON) para diagnóstico. Nunca se pasan contraseñas,
 * cookies, tokens, códigos OTP, claves de API ni datos de contacto del cliente.
 */
export function logEvent(
  event: string,
  data: Record<string, unknown> = {},
  level: 'info' | 'warn' = 'info',
) {
  const line = JSON.stringify({ event, env: process.env.NODE_ENV || 'development', ...data });
  if (level === 'warn') console.warn(line);
  else console.info(line);
}
export const isDevelopment = () => process.env.NODE_ENV !== 'production';

const lastFailures = new Map<string, { reason: string; at: number }>();
/**
 * Fallo de un proceso periódico (worker): registra el motivo real, pero no repite el mismo
 * mensaje en cada vuelta. Se vuelve a registrar si cambia o cada 10 minutos.
 */
export function logWorkerFailure(worker: string, error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);
  // Prisma incluye el fragmento de código en el mensaje: basta la última línea con la causa.
  const reason =
    raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1)
      ?.slice(0, 300) ?? 'Error inesperado';
  const last = lastFailures.get(worker);
  if (last && last.reason === reason && Date.now() - last.at < 600000) return;
  lastFailures.set(worker, { reason, at: Date.now() });
  logEvent(`${worker}.failed`, { reason }, 'warn');
}
