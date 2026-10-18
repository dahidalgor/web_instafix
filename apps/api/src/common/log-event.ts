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
