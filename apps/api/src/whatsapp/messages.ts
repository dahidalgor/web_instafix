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
  /** El cliente no envió la ubicación: la solicitud se cancela a la hora `limite`. */
  'LOCATION_REMINDER',
  /** Recibimos la ubicación (la primera); se avisará cuando un técnico confirme. */
  'LOCATION_RECEIVED',
  /** Otro técnico atenderá la visita confirmada (misma fecha y hora). */
  'TECHNICIAN_CHANGED',
  /** El técnico propone otro horario; el cliente responde con los botones del mensaje. */
  'RESCHEDULE_PROPOSAL',
  /** Presupuesto de un trabajo de taller; el cliente responde «Sí, continuar» / «No, devolver». */
  'REPAIR_QUOTE',
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
  LOCATION_REMINDER: 'appointment_location_reminder',
  LOCATION_RECEIVED: 'appointment_location_received',
  TECHNICIAN_CHANGED: 'appointment_technician_changed',
  RESCHEDULE_PROPOSAL: 'appointment_reschedule_proposal',
  REPAIR_QUOTE: 'repair_quote',
};
export const templateFor = (kind: MessageKind): WhatsAppTemplate => templates[kind];

/**
 * Mientras Meta revisa una plantilla nueva, el aviso sale con una ya aprobada que sirve igual:
 * «cita confirmada, te atenderá {{tecnico}}» cuenta el cambio de técnico.
 */
export const fallbackTemplateFor = (kind: MessageKind): WhatsAppTemplate | null =>
  kind === 'TECHNICIAN_CHANGED' ? 'appointment_confirmed' : null;

/**
 * Valores que Instafix ofrece a cualquier plantilla. Cada plantilla usa los que necesite;
 * el proveedor envía solo los que la versión aprobada declara.
 */
export function messageVariables(
  kind: MessageKind,
  appointment: Pick<Appointment, 'contactName' | 'title' | 'startsAt' | 'timeZone'> &
    Partial<Pick<Appointment, 'technician' | 'responseDueAt' | 'proposedStartsAt'>>,
): TemplateVariables {
  const zone = { timeZone: appointment.timeZone };
  const dateOf = (at: Date) =>
    new Intl.DateTimeFormat('es-EC', { ...zone, weekday: 'long', day: 'numeric', month: 'long' })
      .format(at)
      .replace(',', '');
  const timeOf = (at: Date) =>
    new Intl.DateTimeFormat('es-EC', {
      ...zone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(at);
  const fecha = dateOf(appointment.startsAt);
  const hora = timeOf(appointment.startsAt);
  return {
    ...(appointment.responseDueAt ? { limite: timeOf(appointment.responseDueAt) } : {}),
    ...(appointment.proposedStartsAt
      ? {
          fecha_nueva: dateOf(appointment.proposedStartsAt),
          hora_nueva: timeOf(appointment.proposedStartsAt),
        }
      : {}),
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
