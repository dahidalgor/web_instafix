import { CalApiError, confirmCalBookingRequest, getCalBookingStatus } from './cal-api';
import { ProviderError } from './provider-error';

function providerError(error: unknown, fallback: string): ProviderError {
  if (!(error instanceof CalApiError)) return new ProviderError(fallback, 'REVIEW');
  if (error.kind === 'NOT_CONFIGURED')
    return new ProviderError('Falta configurar Cal.com', 'FAILED');
  if (error.kind === 'REJECTED') return new ProviderError(error.message, 'FAILED');
  return new ProviderError(error.message, 'RETRY');
}

/** Confirma una reserva pendiente. Consultar primero permite recuperar un timeout previo. */
export async function confirmCalBooking(uid: string): Promise<void> {
  let status: string;
  try {
    status = await getCalBookingStatus(uid);
  } catch (error) {
    throw providerError(error, 'Cal.com no responde');
  }
  if (status === 'accepted') return;
  if (status !== 'pending')
    throw new ProviderError(`La reserva Cal no está pendiente (${status})`, 'FAILED');
  try {
    await confirmCalBookingRequest(uid);
  } catch (error) {
    throw providerError(error, 'Verificar confirmación Cal.com en el siguiente intento');
  }
}
