import { ProviderError } from './provider-error';

export async function confirmCalBooking(uid: string): Promise<void> {
  if (!process.env.CAL_API_KEY || !process.env.CAL_API_VERSION)
    throw new ProviderError('Falta configurar Cal.com', 'FAILED');
  const headers = {
    Authorization: `Bearer ${process.env.CAL_API_KEY}`,
    'cal-api-version': process.env.CAL_API_VERSION,
  };
  const url = `https://api.cal.com/v2/bookings/${encodeURIComponent(uid)}`;
  // Consultar primero permite recuperar un timeout después de una confirmación exitosa.
  let current: Response;
  try {
    current = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
  } catch {
    throw new ProviderError('Cal.com no responde', 'RETRY');
  }
  if (!current.ok)
    throw new ProviderError(
      `Cal.com HTTP ${current.status}`,
      current.status >= 500 || current.status === 429 ? 'RETRY' : 'FAILED',
    );
  const result = await current.json();
  const status = String(result?.data?.status ?? '').toLowerCase();
  if (status === 'accepted') return;
  if (status !== 'pending')
    throw new ProviderError(`La reserva Cal no está pendiente (${status})`, 'FAILED');
  let confirmed: Response;
  try {
    confirmed = await fetch(`${url}/confirm`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new ProviderError('Verificar confirmación Cal.com en el siguiente intento', 'RETRY');
  }
  if (!confirmed.ok)
    throw new ProviderError(
      `Cal.com al confirmar: HTTP ${confirmed.status}`,
      confirmed.status >= 500 || confirmed.status === 429 ? 'RETRY' : 'FAILED',
    );
}
