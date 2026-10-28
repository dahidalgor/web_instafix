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
    throw Object.assign(
      new ProviderError(`Cal.com HTTP ${response.status}`, disposition(response.status)),
      { httpStatus: response.status, providerMessage: providerMessage(body) },
    );
  return body;
}

/**
 * Motivo que da Cal.com al rechazar, para diagnóstico. Se recorta y se ocultan correos y
 * teléfonos: nunca se registran datos del cliente ni credenciales.
 */
function providerMessage(body: unknown) {
  const b = body as { error?: { code?: unknown; message?: unknown }; message?: unknown } | null;
  const raw = [b?.error?.code, b?.error?.message, b?.message]
    .filter((v) => typeof v === 'string' || Array.isArray(v))
    .map((v) => (Array.isArray(v) ? v.join('; ') : v))
    .join(' · ');
  return raw
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[correo]')
    .replace(/\+?\d[\d\s-]{7,}\d/g, '[teléfono]')
    .slice(0, 300);
}
export type CalHttpError = ProviderError & { httpStatus?: number; providerMessage?: string };

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
  const first = firstBookableDay(new Date(), timeZone);
  return Object.fromEntries(
    Object.entries(data.data)
      .map(([day, slots]): [string, string[]] => [
        day,
        slots
          .map((slot) => new Date(slot.start))
          .filter((slot) => dayIn(slot, timeZone) >= first)
          .map((slot) => slot.toISOString()),
      ])
      .filter(([, slots]) => slots.length),
  );
}

export async function createCalBooking(input: {
  start: Date;
  name: string;
  /** Sin correo (lo normal): Cal.com identifica al asistente por su teléfono. */
  email?: string | null;
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
          // El correo del cliente nunca se envía. Solo se manda uno propio de Instafix si Cal.com
          // lo exige (ver createBooking); por defecto la reserva va solo con el teléfono.
          ...(input.email ? { email: input.email } : {}),
          timeZone: 'America/Guayaquil',
          phoneNumber: input.phone,
          language: 'es',
        },
        // Solo campos que existen en el tipo de evento: Cal.com rechaza la reserva si falta uno
        // obligatorio (`notes` = «¿Qué trabajo requiere?») o si llega uno desconocido.
        bookingFieldsResponses: {
          notes: input.request,
          attendeePhoneNumber: input.phone,
        },
        // Sin datos personales: referencia opaca, origen y autorización para el webhook.
        metadata: {
          instafixReference: input.reference,
          instafixSource: 'api',
          instafixWhatsappConsent: String(input.whatsappConsent),
        },
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

export const dayIn = (instant: Date, timeZone = 'America/Guayaquil') =>
  new Intl.DateTimeFormat('en-CA', { timeZone }).format(instant);

/**
 * Primer día reservable (fecha de Ecuador). Por defecto mañana: no se agenda para hoy, pero el
 * primer horario de mañana sí, aunque falten menos de 24 h. BOOKING_MIN_DAYS_AHEAD=0 permite
 * reservar hoy. Cal.com debe tener un aviso mínimo corto para ofrecer esos horarios.
 */
export function firstBookableDay(now = new Date(), timeZone = 'America/Guayaquil') {
  const value = Number(process.env.BOOKING_MIN_DAYS_AHEAD ?? 1);
  const days = Number.isInteger(value) && value >= 0 && value <= 30 ? value : 1;
  // Ecuador no tiene horario de verano: un día son siempre 24 h.
  return dayIn(new Date(now.getTime() + days * 86400000), timeZone);
}

/**
 * Revalida un horario contra la disponibilidad actual de Cal.com (sin caché). Compara
 * instantes, no textos: «16:45-05:00» y «21:45:00.000Z» son el mismo horario.
 */
export async function isCalSlotAvailable(start: Date, timeZone = 'America/Guayaquil') {
  const day = dayIn(start, timeZone);
  const days = await getCalSlots(day, day, timeZone);
  const offered = Object.values(days).flat();
  return {
    available: offered.some((slot) => new Date(slot).getTime() === start.getTime()),
    day,
    offered: offered.length,
  };
}
