import { z } from 'zod';

/**
 * Horarios ocupados de los técnicos (clases, otro trabajo, citas médicas…). En esas horas el
 * técnico no recibe solicitudes ni puede confirmar citas. Todo en hora de Ecuador (UTC-5 todo el
 * año): días como «YYYY-MM-DD» y horas como minutos desde las 00H00.
 */
export type BusyBlock = {
  id: string;
  label: string;
  /** Cada semana: 0 = domingo … 6 = sábado. null si es un día concreto. */
  weekday: number | null;
  /** Día concreto. null si se repite cada semana. */
  date: string | null;
  /** Solo para los semanales: desde / hasta qué día rige (opcional, p. ej. fin de semestre). */
  validFrom: string | null;
  validUntil: string | null;
  startMinute: number;
  endMinute: number;
};

export const weekdayNames = [
  'Domingo',
  'Lunes',
  'Martes',
  'Miércoles',
  'Jueves',
  'Viernes',
  'Sábado',
] as const;

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha no válida');
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Hora no válida');
const minutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));

/** Lo que envía el técnico. Un horario semanal puede abarcar varios días a la vez. */
export const busyBlockInputSchema = z
  .object({
    label: z.string().trim().min(2, 'Escribe el motivo (p. ej. «Clases»)').max(60),
    repeat: z.enum(['WEEKLY', 'ONCE']),
    weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
    date: day.optional(),
    validUntil: day.optional(),
    allDay: z.boolean().optional(),
    start: time.optional(),
    end: time.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.repeat === 'WEEKLY' && !value.weekdays?.length)
      ctx.addIssue({ code: 'custom', message: 'Elige al menos un día de la semana' });
    if (value.repeat === 'ONCE' && !value.date)
      ctx.addIssue({ code: 'custom', message: 'Elige el día' });
    if (!value.allDay) {
      if (!value.start || !value.end)
        ctx.addIssue({ code: 'custom', message: 'Indica desde y hasta qué hora' });
      else if (minutes(value.end) <= minutes(value.start))
        ctx.addIssue({ code: 'custom', message: 'La hora de fin debe ser después del inicio' });
    }
  });
export type BusyBlockInput = z.infer<typeof busyBlockInputSchema>;

/** Convierte la entrada en los bloques que se guardan (uno por día de la semana). */
export function busyBlocksFromInput(input: BusyBlockInput, today: string): Omit<BusyBlock, 'id'>[] {
  const startMinute = input.allDay ? 0 : minutes(input.start!);
  const endMinute = input.allDay ? 1440 : minutes(input.end!);
  const base = { label: input.label.trim(), startMinute, endMinute };
  if (input.repeat === 'ONCE')
    return [{ ...base, weekday: null, date: input.date!, validFrom: null, validUntil: null }];
  return [...new Set(input.weekdays)].map((weekday) => ({
    ...base,
    weekday,
    date: null,
    validFrom: today,
    validUntil: input.validUntil ?? null,
  }));
}

const OFFSET = 5 * 3600000;
const DAY = 86400000;
/** Día y minuto de Ecuador de un instante. */
function local(at: number) {
  const shifted = new Date(at - OFFSET);
  return {
    day: shifted.toISOString().slice(0, 10),
    weekday: shifted.getUTCDay(),
    minute: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

/** El bloque rige ese día (semanal en su día de la semana y vigencia, o el día concreto). */
export function blockAppliesOn(
  block: Pick<BusyBlock, 'weekday' | 'date' | 'validFrom' | 'validUntil'>,
  day: string,
  weekday: number,
) {
  if (block.date) return block.date === day;
  return (
    block.weekday === weekday &&
    (!block.validFrom || block.validFrom <= day) &&
    (!block.validUntil || day <= block.validUntil)
  );
}

/**
 * Primer bloque que se cruza con [start, end) (hora de Ecuador), o null si el técnico está libre.
 * Una visita que pasa de medianoche se revisa en ambos días.
 */
export function busyBlockAt<T extends Omit<BusyBlock, 'id'>>(
  blocks: T[],
  start: Date,
  end: Date,
): T | null {
  let from = start.getTime();
  const until = end.getTime();
  while (from < until) {
    const here = local(from);
    const dayEnd = from - here.minute * 60000 - (from % 60000) + DAY;
    const to = Math.min(until, dayEnd);
    const startMinute = here.minute;
    const endMinute = startMinute + Math.ceil((to - from) / 60000);
    const hit = blocks.find(
      (block) =>
        blockAppliesOn(block, here.day, here.weekday) &&
        block.startMinute < endMinute &&
        block.endMinute > startMinute,
    );
    if (hit) return hit;
    from = to;
  }
  return null;
}

/** «08H00–12H00» o «Todo el día». */
export function busyBlockHours(block: Pick<BusyBlock, 'startMinute' | 'endMinute'>) {
  if (block.startMinute === 0 && block.endMinute >= 1440) return 'Todo el día';
  const hhmm = (value: number) =>
    `${String(Math.floor(value / 60)).padStart(2, '0')}H${String(value % 60).padStart(2, '0')}`;
  return `${hhmm(block.startMinute)}–${hhmm(Math.min(block.endMinute, 1439))}`;
}
