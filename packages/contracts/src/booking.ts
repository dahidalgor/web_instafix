import { z } from 'zod';
import { emailSchema, personNameSchema } from './auth';
import type { AppointmentStatus } from './appointments';

// La atención es presencial en Ecuador continental; horarios y calendario usan esta zona.
export const bookingTimeZone = 'America/Guayaquil';

export const customerRequestSchema = z
  .string()
  .trim()
  .min(10, 'Cuéntanos un poco más sobre lo que necesitas (mínimo 10 caracteres).')
  .max(1000, 'Resume tu solicitud en menos de 1000 caracteres.');

export const guestContactSchema = z.object({
  firstName: personNameSchema,
  lastName: personNameSchema,
  phone: z.string().trim().min(6).max(30),
  email: emailSchema,
});

/**
 * Cuerpo de «Confirmar cita». Las claves desconocidas se descartan. Con sesión iniciada,
 * el servidor ignora `guest` por completo: nombre, teléfono y correo salen de la cuenta.
 */
export const bookingCreateSchema = z.object({
  requestKey: z.string().uuid(),
  start: z.string().datetime({ offset: true }),
  // El cliente no clasifica su equipo ni el servicio: lo hace el técnico después.
  customerRequest: customerRequestSchema,
  whatsappConsent: z.literal(true, {
    errorMap: () => ({ message: 'Autoriza el contacto por WhatsApp para coordinar la visita.' }),
  }),
  guest: guestContactSchema.optional(),
});
export type BookingCreateInput = z.infer<typeof bookingCreateSchema>;

export const bookingRescheduleSchema = z.object({
  requestKey: z.string().uuid(),
  start: z.string().datetime({ offset: true }),
});
export const bookingCancelSchema = z.object({
  reason: z.string().trim().max(300).optional(),
});

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const availabilityQuerySchema = z.object({
  start: isoDate,
  end: isoDate,
  reschedule: z.string().uuid().optional(),
});

export type BookingSlot = { start: string; end: string };
export type Availability = {
  timeZone: string;
  /** Clave YYYY-MM-DD en la zona horaria de atención. Días sin horarios no aparecen. */
  days: Record<string, BookingSlot[]>;
};

export type BookingConfig = {
  mode: 'native' | 'legacy';
  timeZone: string;
  user: { name: string; maskedPhone: string; email: string | null } | null;
};

/** Códigos estables que la web traduce a mensajes y acciones. */
export type BookingErrorCode =
  | 'ACCOUNT_EXISTS'
  | 'INVALID_EMAIL'
  | 'SLOT_TAKEN'
  | 'IN_PROGRESS'
  | 'UNCERTAIN'
  | 'PROVIDER_UNAVAILABLE'
  | 'REJECTED'
  | 'NOT_CONFIGURED'
  | 'NOT_ALLOWED';

export type MyAppointment = {
  id: string;
  status: AppointmentStatus;
  startsAt: string;
  endsAt: string;
  timeZone: string;
  device: string;
  customerRequest: string;
  assignedService: { title: string; device: string } | null;
  technician: string;
  needsReview: boolean;
  canCancel: boolean;
  canReschedule: boolean;
  rescheduledToId: string | null;
  cancellationReason: string | null;
};

export type BookingResult = {
  appointment: MyAppointment;
  guest: boolean;
};
