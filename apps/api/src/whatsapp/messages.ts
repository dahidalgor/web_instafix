import type { Appointment } from '@prisma/client';

export const messageKinds = [
  'INITIAL',
  'CONFIRMED',
  'DAY_BEFORE',
  'SAME_DAY',
  'RESCHEDULED',
  'CANCELLED',
  'TECHNICIAN_ASSIGNED',
  'TECHNICIAN_ON_THE_WAY',
] as const;
export type MessageKind = (typeof messageKinds)[number];

/**
 * Los avisos automáticos salen siempre como plantillas aprobadas por Meta. Un aviso sin
 * plantilla configurada no se envía: no se sustituye por texto libre fuera de la ventana.
 */
export function templateFor(kind: MessageKind): string | null {
  if (kind === 'SAME_DAY' && process.env.WHATSAPP_TEMPLATE_VISIT_REMINDER)
    return process.env.WHATSAPP_TEMPLATE_VISIT_REMINDER;
  const env: Record<MessageKind, string> = {
    INITIAL: 'WHATSAPP_TEMPLATE_INITIAL',
    CONFIRMED: 'WHATSAPP_TEMPLATE_CONFIRMED',
    DAY_BEFORE: 'WHATSAPP_TEMPLATE_DAY_BEFORE',
    SAME_DAY: 'WHATSAPP_TEMPLATE_SAME_DAY',
    RESCHEDULED: 'WHATSAPP_TEMPLATE_RESCHEDULED',
    CANCELLED: 'WHATSAPP_TEMPLATE_CANCELLED',
    TECHNICIAN_ASSIGNED: 'WHATSAPP_TEMPLATE_TECHNICIAN_ASSIGNED',
    TECHNICIAN_ON_THE_WAY: 'WHATSAPP_TEMPLATE_TECHNICIAN_ON_THE_WAY',
  };
  return process.env[env[kind]] || null;
}

export function messageContent(
  kind: MessageKind,
  appointment: Pick<Appointment, 'contactName' | 'title' | 'startsAt' | 'timeZone'> &
    Partial<Pick<Appointment, 'technician'>>,
) {
  const name = appointment.contactName;
  const work = appointment.title;
  const technician = appointment.technician || 'tu técnico';
  const date = new Intl.DateTimeFormat('es-EC', {
    timeZone: appointment.timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(appointment.startsAt);
  const time = new Intl.DateTimeFormat('es-EC', {
    timeZone: appointment.timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(appointment.startsAt);
  const visitReminder = Boolean(process.env.WHATSAPP_TEMPLATE_VISIT_REMINDER);
  const content: Record<MessageKind, { params: string[]; text: string }> = {
    INITIAL: {
      params: [name, work, date, time],
      text: `Hola ${name}! Hemos recibido su agendamiento para ${work} en el día ${date} a las ${time}, por favor para confirmarla necesitamos que nos envíe en este chat la ubicación donde seria de llegar :)`,
    },
    CONFIRMED: {
      params: [name],
      text: `Listo estimado ${name} ✅\nEsta agendada su cita, se le enviará un aviso automático para que pueda estar pendiente de la llegada de su técnico asignado ✅`,
    },
    DAY_BEFORE: {
      params: [work, time],
      text: `Instafix le recuerda de su cita para el día de mañana!\nTiene ${work} agendado para mañana a las ${time}`,
    },
    // Con la plantilla nueva (instafix_recordatorio_visita) el aviso incluye la hora estimada.
    SAME_DAY: visitReminder
      ? {
          params: [name, time],
          text: `Hola ${name} 👋\nTe recordamos que hoy está agendada tu visita con Instafix.\n🕐 Hora estimada: ${time}\nTu técnico te contactará por este chat antes de llegar.\nTen en cuenta que, debido a trabajos anteriores o condiciones de ruta, la hora de llegada puede variar.\nInstafix 🔧`,
        }
      : {
          params: [name],
          text: `Estimad@ ${name}, le recordamos que su visita está agendada para el día de hoy 😊\nEl técnico se estará comunicando por este chat para informarle cuando esté próximo a llegar ✅\nLa hora agendada corresponde a un horario estimado de llegada. Debido a la duración de servicios anteriores y a los tiempos de traslado, podría presentarse una ligera variación. Agradecemos mucho su comprensión y paciencia 🙌`,
        },
    RESCHEDULED: {
      params: [name, date, time],
      text: `Hola ${name}, tu cita con Instafix fue reprogramada para el ${date} a las ${time} (hora estimada). Tu técnico te contactará por este chat antes de llegar.`,
    },
    CANCELLED: {
      params: [name, date, time],
      text: `Hola ${name}, tu cita con Instafix del ${date} a las ${time} fue cancelada. Si necesitas una nueva visita, puedes agendarla en instafix.ec.`,
    },
    TECHNICIAN_ASSIGNED: {
      params: [name, technician, date],
      text: `Hola ${name}, ${technician} será tu técnico de Instafix para la visita del ${date}. Te contactará por este chat antes de llegar.`,
    },
    TECHNICIAN_ON_THE_WAY: {
      params: [name, technician],
      text: `Hola ${name}, ${technician} de Instafix ya está en camino a tu ubicación. Ten en cuenta que, por condiciones de ruta, la hora de llegada puede variar ligeramente.`,
    },
  };
  return content[kind];
}

// Los recordatorios operan a las 08:00 de Ecuador continental (UTC−05, sin DST).
// La hora de la cita en el texto usa su zona horaria, no la zona del servidor.
export function reminderTimes(startsAt: Date) {
  const day = new Date(startsAt.getTime() - 5 * 3600000).toISOString().slice(0, 10);
  const sameDay = new Date(`${day}T08:00:00-05:00`);
  return {
    sameDay,
    dayBefore: new Date(sameDay.getTime() - 86400000),
    dayStart: new Date(`${day}T00:00:00-05:00`),
  };
}
