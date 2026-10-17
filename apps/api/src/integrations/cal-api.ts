// Cliente de Cal.com API v2. Cal.com es el motor de disponibilidad y reservas;
// la identidad del cliente y el registro de citas viven en PostgreSQL.
// Versiones revisadas en la documentación oficial (octubre de 2026):
//   GET  /v2/slots                         cal-api-version 2024-09-04
//   POST /v2/bookings                      cal-api-version 2026-02-25
//   GET  /v2/bookings/{uid}                cal-api-version 2026-02-25
//   POST /v2/bookings/{uid}/cancel         cal-api-version 2026-02-25
//   POST /v2/bookings/{uid}/reschedule     cal-api-version 2026-02-25
//   POST /v2/bookings/{uid}/confirm        cal-api-version 2026-02-25
//   GET  /v2/bookings                      cal-api-version 2026-05-01
// La clave nunca se registra ni se devuelve al navegador.

export const CAL_VERSIONS = {
  slots: '2024-09-04',
  bookings: '2026-02-25',
  listBookings: '2026-05-01',
} as const;

/**
 * NOT_CONFIGURED: faltan variables. UNAVAILABLE: Cal no respondió y no se cambió nada.
 * REJECTED: Cal rechazó la operación (4xx). UNCERTAIN: una escritura pudo completarse
 * aunque no recibimos respuesta; requiere conciliación antes de repetir.
 */
export type CalErrorKind = 'NOT_CONFIGURED' | 'UNAVAILABLE' | 'REJECTED' | 'UNCERTAIN';
export class CalApiError extends Error {
  constructor(
    message: string,
    public kind: CalErrorKind,
    public status?: number,
  ) {
    super(message);
  }
}

export type CalBooking = {
  uid: string;
  status: string;
  start: string;
  end: string;
  metadata?: Record<string, string>;
  rescheduledToUid?: string;
  rescheduledFromUid?: string;
};

export function calSettings() {
  const eventTypeId = Number(process.env.CAL_EVENT_TYPE_ID);
  return {
    apiKey: process.env.CAL_API_KEY || '',
    eventTypeId: Number.isInteger(eventTypeId) && eventTypeId > 0 ? eventTypeId : null,
    // El simulador local solo se admite fuera de producción.
    baseUrl:
      process.env.NODE_ENV === 'production' || !process.env.CAL_API_BASE_URL
        ? 'https://api.cal.com/v2'
        : process.env.CAL_API_BASE_URL.replace(/\/$/, ''),
  };
}

export function calBookingConfigured() {
  const settings = calSettings();
  return Boolean(settings.apiKey && settings.eventTypeId);
}

type RequestOptions = {
  method?: 'GET' | 'POST';
  version: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  timeoutMs?: number;
};

async function calRequest<T>(path: string, options: RequestOptions): Promise<T> {
  const { apiKey, baseUrl } = calSettings();
  if (!apiKey) throw new CalApiError('Falta configurar Cal.com', 'NOT_CONFIGURED');
  const method = options.method ?? 'GET';
  const url = new URL(baseUrl + path);
  for (const [key, value] of Object.entries(options.query ?? {}))
    if (value !== undefined) url.searchParams.set(key, String(value));
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'cal-api-version': options.version,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(options.timeoutMs ?? 12000),
    });
  } catch {
    throw new CalApiError('Cal.com no respondió', method === 'GET' ? 'UNAVAILABLE' : 'UNCERTAIN');
  }
  const json = (await response.json().catch(() => null)) as {
    data?: unknown;
    error?: { message?: unknown };
    message?: unknown;
  } | null;
  if (!response.ok) {
    const detail = json?.error?.message ?? json?.message;
    // Solo un fragmento del mensaje del proveedor; jamás encabezados ni la clave.
    const message = `Cal.com HTTP ${response.status}${
      typeof detail === 'string' ? `: ${detail.slice(0, 240)}` : ''
    }`;
    if (response.status === 429 || response.status === 503)
      throw new CalApiError(message, 'UNAVAILABLE', response.status);
    if (response.status >= 500)
      throw new CalApiError(
        message,
        method === 'GET' ? 'UNAVAILABLE' : 'UNCERTAIN',
        response.status,
      );
    throw new CalApiError(message, 'REJECTED', response.status);
  }
  return (json?.data ?? null) as T;
}

/** Fecha y hora UTC del inicio de un día local (YYYY-MM-DD) en la zona indicada. */
export function zonedDayStartUtc(date: string, timeZone: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(guess));
  const value = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    value('year'),
    value('month') - 1,
    value('day'),
    value('hour'),
    value('minute'),
    value('second'),
  );
  return new Date(guess - (asUtc - guess));
}

export function localDate(instant: Date | string, timeZone: string) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(instant));
}

type RawSlot = string | { start?: string; end?: string };

/** Normaliza la respuesta de /v2/slots a {fecha: [{start, end}]} con instantes ISO UTC. */
export function normalizeSlots(
  data: unknown,
  timeZone: string,
  fallbackMinutes = 60,
): Record<string, { start: string; end: string }[]> {
  const days: Record<string, { start: string; end: string }[]> = {};
  if (!data || typeof data !== 'object') return days;
  for (const value of Object.values(data as Record<string, RawSlot[]>)) {
    if (!Array.isArray(value)) continue;
    for (const raw of value) {
      const startValue = typeof raw === 'string' ? raw : raw?.start;
      if (!startValue) continue;
      const start = new Date(startValue);
      if (Number.isNaN(start.getTime())) continue;
      const endValue = typeof raw === 'string' ? undefined : raw.end;
      const end = endValue
        ? new Date(endValue)
        : new Date(start.getTime() + fallbackMinutes * 60000);
      if (Number.isNaN(end.getTime()) || end <= start) continue;
      const key = localDate(start, timeZone);
      (days[key] ??= []).push({ start: start.toISOString(), end: end.toISOString() });
    }
  }
  for (const list of Object.values(days)) list.sort((a, b) => a.start.localeCompare(b.start));
  return days;
}

export async function getCalSlots(input: {
  startDate: string;
  endDate: string;
  timeZone: string;
  bookingUidToReschedule?: string;
}) {
  const { eventTypeId } = calSettings();
  if (!eventTypeId) throw new CalApiError('Falta CAL_EVENT_TYPE_ID', 'NOT_CONFIGURED');
  const start = zonedDayStartUtc(input.startDate, input.timeZone);
  const endExclusive = zonedDayStartUtc(
    new Date(Date.parse(`${input.endDate}T12:00:00Z`) + 86400000).toISOString().slice(0, 10),
    input.timeZone,
  );
  const data = await calRequest<unknown>('/slots', {
    version: CAL_VERSIONS.slots,
    query: {
      eventTypeId,
      start: start.toISOString(),
      end: new Date(endExclusive.getTime() - 1000).toISOString(),
      timeZone: input.timeZone,
      format: 'range',
      bookingUidToReschedule: input.bookingUidToReschedule,
    },
  });
  const days = normalizeSlots(data, input.timeZone);
  // Cal puede devolver días contiguos; la respuesta se limita al rango pedido.
  for (const key of Object.keys(days))
    if (key < input.startDate || key > input.endDate) delete days[key];
  return days;
}

function toBooking(data: unknown): CalBooking {
  const value = (Array.isArray(data) ? data[0] : data) as Partial<CalBooking> | null;
  if (!value?.uid || !value.start || !value.end || !value.status)
    throw new CalApiError('Respuesta de Cal.com incompleta', 'UNCERTAIN');
  return {
    uid: value.uid,
    status: String(value.status).toLowerCase(),
    start: value.start,
    end: value.end,
    metadata: value.metadata,
    rescheduledToUid: value.rescheduledToUid,
    rescheduledFromUid: value.rescheduledFromUid,
  };
}

export async function createCalBooking(input: {
  start: string;
  attendee: { name: string; email: string; phoneNumber: string; timeZone: string };
  bookingFieldsResponses: Record<string, unknown>;
  metadata: Record<string, string>;
}) {
  const { eventTypeId } = calSettings();
  if (!eventTypeId) throw new CalApiError('Falta CAL_EVENT_TYPE_ID', 'NOT_CONFIGURED');
  const data = await calRequest<unknown>('/bookings', {
    method: 'POST',
    version: CAL_VERSIONS.bookings,
    timeoutMs: 20000,
    body: {
      start: new Date(input.start).toISOString(),
      eventTypeId,
      attendee: { ...input.attendee, language: 'es' },
      bookingFieldsResponses: input.bookingFieldsResponses,
      metadata: input.metadata,
    },
  });
  return toBooking(data);
}

export async function getCalBooking(uid: string) {
  return toBooking(
    await calRequest<unknown>(`/bookings/${encodeURIComponent(uid)}`, {
      version: CAL_VERSIONS.bookings,
    }),
  );
}

export async function cancelCalBooking(uid: string, reason: string) {
  await calRequest<unknown>(`/bookings/${encodeURIComponent(uid)}/cancel`, {
    method: 'POST',
    version: CAL_VERSIONS.bookings,
    body: { cancellationReason: reason },
  });
}

export async function rescheduleCalBooking(uid: string, start: string, reason: string) {
  return toBooking(
    await calRequest<unknown>(`/bookings/${encodeURIComponent(uid)}/reschedule`, {
      method: 'POST',
      version: CAL_VERSIONS.bookings,
      timeoutMs: 20000,
      body: { start: new Date(start).toISOString(), reschedulingReason: reason },
    }),
  );
}

export async function getCalBookingStatus(uid: string) {
  const data = await calRequest<{ status?: unknown } | null>(
    `/bookings/${encodeURIComponent(uid)}`,
    {
      version: CAL_VERSIONS.bookings,
    },
  );
  return String(data?.status ?? '').toLowerCase();
}

export async function confirmCalBookingRequest(uid: string) {
  await calRequest<unknown>(`/bookings/${encodeURIComponent(uid)}/confirm`, {
    method: 'POST',
    version: CAL_VERSIONS.bookings,
  });
}

/** Busca la reserva creada para una cita concreta, usando la metadata que enviamos. */
export async function findCalBookingForAppointment(input: {
  appointmentId: string;
  start: Date;
  attendeeEmail: string | null;
}) {
  const { eventTypeId } = calSettings();
  const data = await calRequest<unknown>('/bookings', {
    version: CAL_VERSIONS.listBookings,
    query: {
      eventTypeId: eventTypeId ?? undefined,
      attendeeEmail: input.attendeeEmail ?? undefined,
      afterStart: new Date(input.start.getTime() - 60000).toISOString(),
      beforeEnd: new Date(input.start.getTime() + 86400000).toISOString(),
      limit: 100,
    },
  });
  const list = Array.isArray(data) ? (data as Partial<CalBooking>[]) : [];
  const match = list.find((item) => item.metadata?.instafixAppointmentId === input.appointmentId);
  return match ? toBooking(match) : null;
}

export function appointmentStatusFromCal(status: string) {
  const value = status.toLowerCase();
  if (value === 'accepted') return 'CONFIRMED' as const;
  if (value === 'pending' || value === 'awaiting_host') return 'PENDING_LOCATION' as const;
  if (value === 'cancelled' || value === 'rejected') return 'CANCELLED' as const;
  return 'PENDING_LOCATION' as const;
}
