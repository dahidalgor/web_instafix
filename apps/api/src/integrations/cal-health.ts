import { calEventTypeId, dayIn, firstBookableDay, getCalSlots } from './cal-client';
import { ProviderError } from './provider-error';

const TIME_ZONE = 'America/Guayaquil';
const eventTypesVersion = () => process.env.CAL_EVENT_TYPES_API_VERSION || '2024-06-14';

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
  problems: string[];
  notes: string[];
};

async function eventType() {
  if (!process.env.CAL_API_KEY) throw new ProviderError('Falta configurar Cal.com', 'FAILED');
  const response = await fetch(`https://api.cal.com/v2/event-types/${calEventTypeId()}`, {
    redirect: 'error',
    headers: {
      Authorization: `Bearer ${process.env.CAL_API_KEY}`,
      'cal-api-version': eventTypesVersion(),
    },
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new ProviderError(`Cal.com HTTP ${response.status}`, 'FAILED');
  const body = (await response.json().catch(() => null)) as { data?: unknown } | null;
  return (body?.data ?? null) as Record<string, unknown> | null;
}

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
      if (event.hidden)
        notes.push(
          'El evento está oculto en tu perfil de Cal.com. Su enlace directo sigue funcionando.',
        );
      if ((event.minimumBookingNotice ?? 0) > 12 * 60)
        notes.push(
          `Aviso mínimo en Cal.com: ${Math.round((event.minimumBookingNotice ?? 0) / 60)} h. Puede quitar los primeros horarios de mañana; se recomienda 1 h.`,
        );
    }
  } catch {
    notes.push('No se pudo leer la configuración del evento en Cal.com.');
  }
  return { ok: problems.length === 0, slots, days, event, problems, notes };
}
