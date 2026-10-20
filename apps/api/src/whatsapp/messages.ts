import type { Appointment } from '@prisma/client';
import type { TemplateVariables, WhatsAppTemplate } from './provider';

/** Avisos automáticos de una cita. Cada uno sale como plantilla aprobada (ver provider.ts). */
export const messageKinds = [
  'INITIAL',
  'CONFIRMED',
  'DAY_BEFORE',
  'SAME_DAY',
  'RESCHEDULED',
  'CANCELLED',
] as const;
export type MessageKind = (typeof messageKinds)[number];
export const isMessageKind = (kind: string): kind is MessageKind =>
  (messageKinds as readonly string[]).includes(kind);

const templates: Record<MessageKind, WhatsAppTemplate> = {
  INITIAL: 'appointment_requested',
  CONFIRMED: 'appointment_confirmed',
  DAY_BEFORE: 'appointment_reminder',
  SAME_DAY: 'appointment_reminder',
  RESCHEDULED: 'appointment_rescheduled',
  CANCELLED: 'appointment_cancelled',
};
export const templateFor = (kind: MessageKind): WhatsAppTemplate => templates[kind];

/**
 * Valores que Instafix ofrece a cualquier plantilla. Cada plantilla usa los que necesite;
 * el proveedor envía solo los que la versión aprobada declara.
 */
export function messageVariables(
  kind: MessageKind,
  appointment: Pick<Appointment, 'contactName' | 'title' | 'startsAt' | 'timeZone'> &
    Partial<Pick<Appointment, 'technician'>>,
): TemplateVariables {
  const zone = { timeZone: appointment.timeZone };
  const fecha = new Intl.DateTimeFormat('es-EC', {
    ...zone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  })
    .format(appointment.startsAt)
    .replace(',', '');
  const hora = new Intl.DateTimeFormat('es-EC', {
    ...zone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(appointment.startsAt);
  return {
    nombre: appointment.contactName.trim().split(/\s+/)[0] || appointment.contactName,
    servicio: appointment.title.slice(0, 120),
    fecha,
    hora,
    tecnico: appointment.technician || 'tu técnico de Instafix',
    cuando: kind === 'DAY_BEFORE' ? 'mañana' : kind === 'SAME_DAY' ? 'hoy' : fecha,
  };
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
