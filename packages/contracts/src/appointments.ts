import { z } from 'zod';
export const appointmentStatuses = [
  'PENDING_LOCATION',
  'CONFIRMED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
] as const;
export const appointmentLabels = {
  PENDING_LOCATION: 'Pendiente de ubicación',
  CONFIRMED: 'Confirmada',
  IN_PROGRESS: 'En servicio',
  COMPLETED: 'Completada',
  CANCELLED: 'Cancelada',
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
export type Appointment = z.infer<typeof appointmentSchema> & {
  id: string;
  bookingIdentityIssue?: string | null;
  assignedService?: { title: string; device: string } | null;
};
