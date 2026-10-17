import { z } from 'zod';
// Estados que administración puede asignar manualmente a una cita.
export const appointmentStatuses = [
  'PENDING_LOCATION',
  'CONFIRMED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
  'NO_SHOW',
] as const;
// Estados de la CITA. CREATING y FAILED son internos de la creación en Cal.com;
// RESCHEDULED marca la reserva sustituida por otra. Ninguno describe la reparación.
export const allAppointmentStatuses = [
  'CREATING',
  'FAILED',
  ...appointmentStatuses,
  'RESCHEDULED',
] as const;
export type AppointmentStatus = (typeof allAppointmentStatuses)[number];
export const appointmentLabels: Record<AppointmentStatus, string> = {
  CREATING: 'Procesando',
  FAILED: 'No completada',
  PENDING_LOCATION: 'Pendiente de confirmación',
  CONFIRMED: 'Confirmada',
  IN_PROGRESS: 'En servicio',
  COMPLETED: 'Completada',
  CANCELLED: 'Cancelada',
  NO_SHOW: 'No asistida',
  RESCHEDULED: 'Reprogramada',
};
export const appointmentSchema = z
  .object({
    userId: z.string().uuid().nullable(),
    contactName: z.string().trim().max(100).optional(),
    contactPhone: z.string().trim().max(30).optional(),
    whatsappConsent: z.boolean().optional(),
    title: z.string().trim().min(3).max(150),
    device: z.string().trim().min(2).max(100),
    startsAt: z.string().datetime({ offset: true }),
    endsAt: z.string().datetime({ offset: true }),
    timeZone: z
      .string()
      .max(100)
      .refine((value) => {
        try {
          new Intl.DateTimeFormat('es', { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }),
    address: z.string().trim().max(500),
    technician: z.string().trim().max(100),
    status: z.enum(appointmentStatuses),
  })
  .strict()
  .refine(
    (value) => new Date(value.endsAt) > new Date(value.startsAt),
    'El fin debe ser posterior al inicio',
  );
export type Appointment = Omit<z.infer<typeof appointmentSchema>, 'status'> & {
  id: string;
  status: AppointmentStatus;
  customerRequest?: string;
  source?: string;
  bookingIdentityIssue?: string | null;
  assignedService?: { title: string; device: string } | null;
};
