import {
  BirdAPIError,
  BirdAuthError,
  BirdBadRequestError,
  BirdBillingError,
  BirdClient,
  BirdConnectionError,
  BirdNotFoundError,
  BirdPermissionError,
  BirdRateLimitError,
  BirdServiceUnavailableError,
  BirdTimeoutError,
  BirdValidationError,
} from '@messagebird/sdk';

/**
 * Único punto de Instafix que conoce el SDK de Bird. Una instancia por proceso: el cliente es
 * sin estado y reutiliza la conexión. La clave vive solo en el backend (BIRD_API_KEY).
 */
let client: BirdClient | null = null;
let receivers = new Map<string, BirdClient>();

/** Solo para pruebas: sustituye el cliente por un doble con la misma forma. */
export function setBirdClient(fake: BirdClient | null) {
  client = fake;
  receivers = new Map();
}

export class BirdConfigError extends Error {}

export function birdClient() {
  const apiKey = process.env.BIRD_API_KEY?.trim();
  if (!apiKey) throw new BirdConfigError('Falta BIRD_API_KEY en el .env del backend');
  if (!/^b[km]_[a-z0-9]+_/.test(apiKey))
    throw new BirdConfigError(
      'BIRD_API_KEY no tiene el formato de Bird (bk_<región>_… o bm_<región>_…): revisa que no tenga comillas ni espacios',
    );
  client ??= new BirdClient({
    apiKey,
    timeout: 15000,
    maxRetries: 2,
    // Sin telemetría «client enrichment» del SDK: Instafix no comparte datos del entorno.
    defaultHeaders: { 'Bird-Enrichment': '0' },
  });
  return client;
}

/**
 * Cliente receptor (sin API key) para verificar webhooks con el secreto de firma de Bird.
 * La verificación no hace peticiones de red.
 */
export function birdWebhookReceiver(secret: string) {
  let receiver = receivers.get(secret);
  if (!receiver) {
    receiver = new BirdClient({ webhooks: { secret } });
    receivers.set(secret, receiver);
  }
  return receiver;
}

/** Solo la región de la clave, para diagnóstico. Nunca se muestra la clave. */
export const birdKeyRegion = () =>
  process.env.BIRD_API_KEY?.trim().match(/^b[km]_([a-z0-9]+)_/)?.[1] ?? null;

/** Categorías de error de Instafix a partir de los errores tipados del SDK. */
export type BirdFailure =
  | 'CONFIG'
  | 'AUTH'
  | 'PERMISSION'
  | 'NOT_FOUND'
  | 'VALIDATION'
  | 'BILLING'
  | 'RATE_LIMIT'
  | 'PROVIDER_UNAVAILABLE'
  | 'NETWORK'
  | 'UNKNOWN';

export function describeBirdError(error: unknown): { kind: BirdFailure; message: string } {
  if (error instanceof BirdConfigError) return { kind: 'CONFIG', message: error.message };
  if (error instanceof BirdConnectionError || error instanceof BirdTimeoutError)
    return { kind: 'NETWORK', message: 'Sin conexión con Bird (red o tiempo agotado)' };
  if (error instanceof BirdAPIError) {
    const kind: BirdFailure =
      error instanceof BirdAuthError
        ? 'AUTH'
        : error instanceof BirdPermissionError
          ? 'PERMISSION'
          : error instanceof BirdNotFoundError
            ? 'NOT_FOUND'
            : error instanceof BirdValidationError || error instanceof BirdBadRequestError
              ? 'VALIDATION'
              : error instanceof BirdBillingError
                ? 'BILLING'
                : error instanceof BirdRateLimitError
                  ? 'RATE_LIMIT'
                  : error instanceof BirdServiceUnavailableError || error.statusCode >= 500
                    ? 'PROVIDER_UNAVAILABLE'
                    : 'UNKNOWN';
    // Código y mensaje de Bird (sin datos del destinatario) y el id de la petición para soporte.
    const detail = `${error.statusCode} ${error.code} · ${error.message}`;
    return {
      kind,
      message: `${detail}${error.requestId ? ` · request ${error.requestId}` : ''}`.slice(0, 400),
    };
  }
  return {
    kind: 'UNKNOWN',
    message: error instanceof Error ? error.message.slice(0, 300) : 'Error desconocido',
  };
}
