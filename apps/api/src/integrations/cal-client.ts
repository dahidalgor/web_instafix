import { z } from 'zod';
import { ProviderError } from './provider-error';

/**
 * Cal.com es solo el motor de agenda: disponibilidad, reservas, cancelación y reprogramación.
 * Los mensajes al cliente los envía Instafix. Versiones por endpoint según la API v2.
 */
const CAL_BASE = 'https://api.cal.com/v2';
const bookingsVersion = () => process.env.CAL_API_VERSION || '2026-02-25';
const slotsVersion = () => process.env.CAL_SLOTS_API_VERSION || '2024-09-04';

function headers(version: string) {
  if (!process.env.CAL_API_KEY) throw new ProviderError('Falta configurar Cal.com', 'FAILED');
  return {
    Authorization: `Bearer ${process.env.CAL_API_KEY}`,
    'cal-api-version': version,
    'Content-Type': 'application/json',
  };
}
const disposition = (status: number) => (status >= 500 || status === 429 ? 'RETRY' : 'FAILED');

async function call(path: string, version: string, init: RequestInit = {}, uncertain = false) {
  let response: Response;
  try {
    response = await fetch(`${CAL_BASE}${path}`, {
      ...init,
      redirect: 'error',
      headers: headers(version),
      signal: AbortSignal.timeout(12000),
    });
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    // Una creación sin respuesta puede haber ocurrido: se concilia con el webhook firmado.
    throw new ProviderError(
      uncertain ? 'Cal.com no respondió; resultado incierto' : 'Cal.com no responde',
      uncertain ? 'REVIEW' : 'RETRY',
    );
  }
  const body = await response.json().catch(() => null);
  if (!response.ok)
    throw Object.assign(new ProviderError(`Cal.com HTTP ${response.status}`, disposition(response.status)), {
      httpStatus: response.status,
    });
  return body;
}

const booking = z
  .object({
    uid: z.string().min(1).max(200),
    status: z.string().optional(),
    start: z.string().datetime({ offset: true }),
    end: z.string().datetime({ offset: true }),
  })
  .passthrough();
export type CalBooking = { uid: string; status: string; start: Date; end: Date };
function parseBooking(body: unknown): CalBooking {
  const data = (body as { data?: unknown })?.data;
  const parsed = booking.safeParse(Array.isArray(data) ? data[0] : data);
  if (!parsed.success)
    throw new ProviderError('Cal.com devolvió una reserva sin datos reconocibles', 'REVIEW');
  return {
    uid: parsed.data.uid,
    status: String(parsed.data.status || 'accepted').toLowerCase(),
    start: new Date(parsed.data.start),
    end: new Date(parsed.data.end),
  };
}

export function calEventTypeId() {
  const id = Number(process.env.CAL_EVENT_TYPE_ID);
  if (!Number.isInteger(id) || id <= 0)
    throw new ProviderError('Falta configurar el tipo de evento Cal', 'FAILED');
  return id;
}

/** Horarios disponibles agrupados por día (YYYY-MM-DD) en la zona indicada. */
export async function getCalSlots(start: string, end: string, timeZone: string) {
  const query = new URLSearchParams({
    eventTypeId: String(calEventTypeId()),
    start,
    end,
    timeZone,
  });
  const body = await call(`/slots?${query}`, slotsVersion());
  const data = z
    .record(z.array(z.object({ start: z.string().datetime({ offset: true }) }).passthrough()))
    .safeParse(body?.data);
  if (!data.success) throw new ProviderError('Cal.com devolvió horarios no reconocibles', 'RETRY');
  return Object.fromEntries(
    Object.entries(data.data).map(([day, slots]) => [
      day,
      slots.map((slot) => new Date(slot.start).toISOString()),
    ]),
  );
}

export async function createCalBooking(input: {
  start: Date;
  name: string;
  email: string;
  phone: string;
  request: string;
  whatsappConsent: boolean;
  reference: string;
}) {
  const body = await call(
    '/bookings',
    bookingsVersion(),
    {
      method: 'POST',
      body: JSON.stringify({
        start: input.start.toISOString(),
        eventTypeId: calEventTypeId(),
        attendee: {
          name: input.name,
          email: input.email,
          timeZone: 'America/Guayaquil',
          phoneNumber: input.phone,
          language: 'es',
        },
        bookingFieldsResponses: {
          servicio: input.request,
          whatsappConsent: input.whatsappConsent,
          attendeePhoneNumber: input.phone,
        },
        // Sin datos personales: solo la referencia opaca y el origen para conciliar el webhook.
        metadata: { instafixReference: input.reference, instafixSource: 'api' },
      }),
    },
    true,
  );
  return parseBooking(body);
}

export async function cancelCalBooking(uid: string, reason: string) {
  await call(`/bookings/${encodeURIComponent(uid)}/cancel`, bookingsVersion(), {
    method: 'POST',
    body: JSON.stringify({ cancellationReason: reason }),
  });
}

/** Cal.com crea una reserva nueva al reprogramar; devuelve su uid, horario y estado. */
export async function rescheduleCalBooking(uid: string, start: Date, reason: string) {
  const body = await call(
    `/bookings/${encodeURIComponent(uid)}/reschedule`,
    bookingsVersion(),
    {
      method: 'POST',
      body: JSON.stringify({ start: start.toISOString(), reschedulingReason: reason }),
    },
    true,
  );
  return parseBooking(body);
}

export async function confirmCalBooking(uid: string): Promise<void> {
  if (!process.env.CAL_API_KEY || !process.env.CAL_API_VERSION)
    throw new ProviderError('Falta configurar Cal.com', 'FAILED');
  const path = `/bookings/${encodeURIComponent(uid)}`;
  // Consultar primero permite recuperar un timeout después de una confirmación exitosa.
  const current = await call(path, bookingsVersion());
  const status = String(current?.data?.status ?? '').toLowerCase();
  if (status === 'accepted') return;
  if (status !== 'pending')
    throw new ProviderError(`La reserva Cal no está pendiente (${status})`, 'FAILED');
  try {
    await call(`${path}/confirm`, bookingsVersion(), { method: 'POST' });
  } catch (error) {
    if (error instanceof ProviderError && error.message === 'Cal.com no responde')
      throw new ProviderError('Verificar confirmación Cal.com en el siguiente intento', 'RETRY');
    throw error;
  }
}
