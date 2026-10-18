export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    /** Cuerpo de error del backend: código (p. ej. PHONE_UNVERIFIED) y datos asociados. */
    public body: Record<string, any> | null = null,
  ) {
    super(message);
  }
  get code(): string | undefined {
    return typeof this.body?.code === 'string' ? this.body.code : undefined;
  }
}
const sessionPaths = [
  'auth/login',
  'auth/phone/verify',
  'auth/logout',
  'auth/password-reset/complete',
];
/** Mensajes según la causa real: no se presenta un fallo de red como «cuenta desactivada». */
const networkMessage =
  'No se pudo conectar con el servidor de Instafix. Revisa tu conexión e inténtalo de nuevo.';
const serverMessage = (status: number) =>
  `El servidor tuvo un problema inesperado (código ${status}). Inténtalo de nuevo en unos minutos.`;

export async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/v1/${path}`, {
      ...options,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...options.headers },
    });
  } catch (error) {
    // Cancelaciones intencionadas se propagan tal cual.
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    if (import.meta.env.DEV) console.warn('[api] sin conexión', { path });
    throw new ApiError(networkMessage, 0, { code: 'NETWORK_ERROR' });
  }
  // El encabezado se sincroniza tras cambios de sesión y sesiones caducadas.
  if ((response.ok && sessionPaths.includes(path)) || response.status === 401)
    window.dispatchEvent(new Event('instafix:session-change'));
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const structured = body && typeof body === 'object' && typeof body.message === 'string';
    if (import.meta.env.DEV)
      console.warn('[api] error', { path, status: response.status, code: body?.code ?? null });
    if (response.status === 429)
      throw new ApiError(
        'Demasiados intentos seguidos. Espera un minuto y vuelve a intentarlo.',
        429,
        { code: 'RATE_LIMITED' },
      );
    // 5xx sin cuerpo JSON: responde el proxy (Vite/Caddy) porque la API no está disponible.
    if (response.status >= 500 && !body)
      throw new ApiError(
        `No pudimos conectar con el servidor de Instafix: la API no responde (código ${response.status}). Inténtalo de nuevo en unos minutos.`,
        response.status,
        { code: 'API_UNREACHABLE' },
      );
    // 5xx sin mensaje propio (o la API caída detrás del proxy): error del servidor, no del usuario.
    if (response.status >= 500 && (!structured || body.message === 'Internal server error'))
      throw new ApiError(serverMessage(response.status), response.status, {
        ...(body && typeof body === 'object' ? body : {}),
        code: body?.code ?? 'SERVER_ERROR',
      });
    throw new ApiError(
      structured
        ? body.message
        : 'No pudimos completar la operación. Revisa los datos o la conexión.',
      response.status,
      body && typeof body === 'object' ? body : null,
    );
  }
  return response.json().catch(() => {
    throw new ApiError(serverMessage(response.status), response.status, { code: 'BAD_RESPONSE' });
  });
}
