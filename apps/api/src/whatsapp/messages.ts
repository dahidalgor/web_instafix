import type { Appointment } from '@prisma/client';

export const messageKinds = ['INITIAL', 'CONFIRMED', 'DAY_BEFORE', 'SAME_DAY'] as const;
export type MessageKind = (typeof messageKinds)[number];
export function messageContent(
  kind: MessageKind,
  appointment: Pick<Appointment, 'contactName' | 'title' | 'startsAt' | 'timeZone'>,
) {
  const name = appointment.contactName;
  const work = appointment.title;
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
  const content = {
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
    SAME_DAY: {
      params: [name],
      text: `Estimad@ ${name}, le recordamos que su visita está agendada para el día de hoy 😊\nEl técnico se estará comunicando por este chat para informarle cuando esté próximo a llegar ✅\nLa hora agendada corresponde a un horario estimado de llegada. Debido a la duración de servicios anteriores y a los tiempos de traslado, podría presentarse una ligera variación. Agradecemos mucho su comprensión y paciencia 🙌`,
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
