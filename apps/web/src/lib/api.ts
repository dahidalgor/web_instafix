export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    /** Código estable enviado por la API (p. ej. SLOT_TAKEN, ACCOUNT_EXISTS). */
    public code?: string,
  ) {
    super(message);
  }
}
export async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/v1/${path}`, {
    ...options,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  // El encabezado se sincroniza tras cambios de sesión y sesiones caducadas.
  if (
    (response.ok &&
      ['auth/login', 'auth/verify-email', 'auth/logout', 'auth/reset-password'].includes(path)) ||
    response.status === 401
  )
    window.dispatchEvent(new Event('instafix:session-change'));
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new ApiError(
      typeof body?.message === 'string'
        ? body.message
        : 'No pudimos completar la operación. Revisa los datos o la conexión.',
      response.status,
      typeof body?.code === 'string' ? body.code : undefined,
    );
  }
  return response.json();
}
