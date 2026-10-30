import { calEventTypeId, dayIn, firstBookableDay, getCalSlots } from './cal-client';
import { ProviderError } from './provider-error';

const TIME_ZONE = 'America/Guayaquil';
const eventTypesVersion = () => process.env.CAL_EVENT_TYPES_API_VERSION || '2024-06-14';
const schedulesVersion = () => process.env.CAL_SCHEDULES_API_VERSION || '2024-06-11';

/** Campos del formulario de Cal.com que la web de Instafix envía al reservar. */
const SENT_FIELDS = new Set(['name', 'attendeePhoneNumber', 'notes']);

type Field = { slug?: string; name?: string; required?: boolean; hidden?: boolean; type?: string };
export type CalHealth = {
  ok: boolean;
  /** Horarios que ofrece Cal.com en los próximos 30 días (desde el primer día reservable). */
  slots: number | null;
  days: number | null;
  event: {
    title: string | null;
    hidden: boolean | null;
    lengthInMinutes: number | null;
    minimumBookingNotice: number | null;
  } | null;
  /** Ajustes del evento que deciden si hay horarios (sin datos de clientes). */
  config: Record<string, unknown> | null;
  /** Horario (disponibilidad) que usa el evento. */
  schedule: {
    id: number | null;
    name: string | null;
    timeZone: string | null;
    availability: { days: string[]; startTime: string; endTime: string }[];
    overrides: number;
  } | null;
  problems: string[];
  notes: string[];
};

async function calGet(path: string, version: string) {
  if (!process.env.CAL_API_KEY) throw new ProviderError('Falta configurar Cal.com', 'FAILED');
  const response = await fetch(`https://api.cal.com/v2${path}`, {
    redirect: 'error',
    headers: {
      Authorization: `Bearer ${process.env.CAL_API_KEY}`,
      'cal-api-version': version,
    },
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new ProviderError(`Cal.com HTTP ${response.status}`, 'FAILED');
  const body = (await response.json().catch(() => null)) as { data?: unknown } | null;
  return (body?.data ?? null) as Record<string, unknown> | null;
}
const eventType = () => calGet(`/event-types/${calEventTypeId()}`, eventTypesVersion());
/** Horario del evento; sin uno propio, el horario predeterminado de la cuenta. */
const schedule = (id: number | null) =>
  calGet(id ? `/schedules/${id}` : '/schedules/default', schedulesVersion());

/**
 * Revisión de la agenda para Administración: que Cal.com ofrezca horarios y que el tipo de
 * evento no exija datos que la web no envía (Cal.com rechazaría todas las reservas).
 */
export async function calHealth(now = new Date()): Promise<CalHealth> {
  const problems: string[] = [];
  const notes: string[] = [];
  let slots: number | null = null;
  let days: number | null = null;
  try {
    const from = firstBookableDay(now, TIME_ZONE);
    const to = dayIn(
      new Date(new Date(`${from}T12:00:00-05:00`).getTime() + 29 * 86400000),
      TIME_ZONE,
    );
    const found = await getCalSlots(from, to, TIME_ZONE);
    days = Object.keys(found).length;
    slots = Object.values(found).flat().length;
    if (!slots)
      problems.push(
        'Cal.com no ofrece ningún horario en los próximos 30 días: la web mostrará el calendario vacío. Revisa en Cal.com la disponibilidad (horario) asignada al evento, el rango de fechas reservables y los límites de reservas.',
      );
  } catch (error) {
    problems.push(
      `No se pudieron consultar los horarios de Cal.com (${error instanceof Error ? error.message : 'error'}). Revisa CAL_API_KEY y CAL_EVENT_TYPE_ID.`,
    );
  }
  let event: CalHealth['event'] = null;
  let config: CalHealth['config'] = null;
  let hours: CalHealth['schedule'] = null;
  try {
    const data = await eventType();
    if (data) {
      const num = (v: unknown) => (typeof v === 'number' ? v : null);
      event = {
        title: typeof data.title === 'string' ? data.title : null,
        hidden: typeof data.hidden === 'boolean' ? data.hidden : null,
        lengthInMinutes: num(data.lengthInMinutes),
        minimumBookingNotice: num(data.minimumBookingNotice),
      };
      const fields = (Array.isArray(data.bookingFields) ? data.bookingFields : []) as Field[];
      for (const field of fields) {
        const id = field.slug || field.name || '';
        if (!field.required || field.hidden || SENT_FIELDS.has(id)) continue;
        if (id === 'email')
          notes.push(
            'Cal.com pide correo: Instafix reserva con su buzón de respaldo (nunca el del cliente). Puedes quitarlo en Cal.com.',
          );
        else
          problems.push(
            `El campo «${id}» es obligatorio en Cal.com y la web no lo envía: Cal.com rechazará las reservas. Hazlo opcional.`,
          );
      }
      // Solo ajustes de agenda: nunca datos de reservas ni de clientes.
      const pick = (keys: string[]) =>
        Object.fromEntries(keys.filter((k) => data[k] !== undefined).map((k) => [k, data[k]]));
      config = pick([
        'id',
        'slug',
        'hidden',
        'scheduleId',
        'lengthInMinutes',
        'minimumBookingNotice',
        'bookingWindow',
        'bookingLimitsCount',
        'bookingLimitsDuration',
        'bookerActiveBookingsLimit',
        'onlyShowFirstAvailableSlot',
        'slotInterval',
        'offsetStart',
        'beforeEventBuffer',
        'afterEventBuffer',
        'seats',
        'confirmationPolicy',
        'requiresConfirmation',
        'disableGuests',
      ]);
      const window = data.bookingWindow as
        { type?: string; value?: unknown; rolling?: boolean } | null | undefined;
      if (window?.type === 'range' && Array.isArray(window.value)) {
        const end = String(window.value[1] ?? '').slice(0, 10);
        if (end && end < dayIn(now, TIME_ZONE))
          problems.push(
            `El rango de fechas reservables del evento terminó el ${end}: Cal.com no ofrece fechas después. Cámbialo en el evento → Limits → «Limit future bookings».`,
          );
      }
      try {
        const scheduleId = typeof data.scheduleId === 'number' ? data.scheduleId : null;
        const found = await schedule(scheduleId);
        if (found) {
          const availability = (Array.isArray(found.availability) ? found.availability : []) as {
            days?: string[];
            startTime?: string;
            endTime?: string;
          }[];
          hours = {
            id: typeof found.id === 'number' ? found.id : scheduleId,
            name: typeof found.name === 'string' ? found.name : null,
            timeZone: typeof found.timeZone === 'string' ? found.timeZone : null,
            availability: availability.map((a) => ({
              days: a.days ?? [],
              startTime: a.startTime ?? '',
              endTime: a.endTime ?? '',
            })),
            overrides: Array.isArray(found.overrides) ? found.overrides.length : 0,
          };
          if (!hours.availability.some((a) => a.days.length))
            problems.push(
              `El horario «${hours.name ?? hours.id}» no tiene días con horas: Cal.com no ofrece horarios. Añade días y horas en Cal.com → Availability.`,
            );
        }
      } catch {
        notes.push('No se pudo leer el horario (Availability) del evento en Cal.com.');
      }
      if (event.hidden)
        notes.push(
          slots === 0 && !problems.some((p) => !p.startsWith('Cal.com no ofrece'))
            ? 'El evento está oculto en tu perfil de Cal.com y no hay otra causa visible: vuelve a mostrarlo y repite la revisión para descartarlo.'
            : 'El evento está oculto en tu perfil de Cal.com. Su enlace directo sigue funcionando.',
        );
      if ((event.minimumBookingNotice ?? 0) > 12 * 60)
        notes.push(
          `Aviso mínimo en Cal.com: ${Math.round((event.minimumBookingNotice ?? 0) / 60)} h. Puede quitar los primeros horarios de mañana; se recomienda 1 h.`,
        );
    }
  } catch {
    notes.push('No se pudo leer la configuración del evento en Cal.com.');
  }
  return {
    ok: problems.length === 0,
    slots,
    days,
    event,
    config,
    schedule: hours,
    problems,
    notes,
  };
}
