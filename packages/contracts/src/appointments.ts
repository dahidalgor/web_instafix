import { z } from 'zod';
export const appointmentStatuses = [
  'PENDING_LOCATION',
  'CONFIRMED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
] as const;
export const appointmentLabels = {
  PENDING_LOCATION: 'Pendiente de confirmación',
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
  assignedTechnician?: { name: string } | null;
  services?: PerformedService[];
  confirmedAt?: string | null;
  completedAt?: string | null;
  locationReceivedAt?: string | null;
};

/** Reserva creada por Instafix. El cliente describe su necesidad; no elige un servicio. */
export const bookingRequestSchema = z
  .object({
    start: z.string().datetime({ offset: true }),
    name: z.string().trim().min(2).max(100).optional(),
    email: z.union([z.string().trim().toLowerCase().email().max(254), z.literal('')]).optional(),
    phone: z.string().trim().max(30).optional(),
    request: z.string().trim().min(3, 'Cuéntanos qué necesitas').max(500),
    whatsappConsent: z.boolean(),
  })
  .strict();
export const rescheduleSchema = z.object({ start: z.string().datetime({ offset: true }) }).strict();
export type BookingResult = {
  appointmentId: string;
  startsAt: string;
  endsAt: string;
  status: (typeof appointmentStatuses)[number];
  email: { status: 'SENT' | 'PENDING' | 'NONE'; maskedEmail: string | null };
  account: 'LINKED' | 'GUEST';
};

/** Servicio realmente realizado en una visita (distinto de la solicitud del cliente). */
export type PerformedService = {
  id: string;
  offeringId: string | null;
  nameSnapshot: string;
  deviceSnapshot: string;
  unitPriceMinor: number;
  quantity: number;
  totalMinor: number;
  currency: string;
  warrantyDaysSnapshot: number;
};
export const addPerformedServiceSchema = z
  .object({
    offeringId: z.string().min(1).max(100),
    quantity: z.number().int().min(1).max(100).default(1),
  })
  .strict();
export const updatePerformedServiceSchema = z
  .object({ quantity: z.number().int().min(1).max(100) })
  .strict();
export const technicianNotesSchema = z.object({ notes: z.string().trim().max(5000) }).strict();

/** Cita tal como la ve el equipo técnico. */
export type StaffAppointment = {
  id: string;
  status: (typeof appointmentStatuses)[number];
  startsAt: string;
  endsAt: string;
  timeZone: string;
  request: string;
  device: string;
  contactName: string;
  contactPhone: string;
  contactEmail: string | null;
  address: string;
  locationLatitude: number | null;
  locationLongitude: number | null;
  locationReceivedAt: string | null;
  automationIssue: string | null;
  bookingIdentityIssue: string | null;
  calStatus: string | null;
  assignedTechnician: { id: string; name: string } | null;
  confirmedAt: string | null;
  completedAt: string | null;
  technicianNotes?: string;
  services: PerformedService[];
  canManage: boolean;
};

export const staffMemberSchema = z
  .object({
    firstName: z.string().trim().min(2).max(50),
    lastName: z.string().trim().min(2).max(50),
    email: z.union([z.string().trim().toLowerCase().email().max(254), z.literal('')]).optional(),
    phone: z.string().trim().min(6).max(30),
    password: z.string().min(12, 'Usa al menos 12 caracteres').max(128),
  })
  .strict();
export const staffUpdateSchema = z
  .object({
    active: z.boolean().optional(),
    password: z.string().min(12, 'Usa al menos 12 caracteres').max(128).optional(),
  })
  .strict();
export type StaffMember = {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  role: 'ADMIN' | 'TECHNICIAN';
  active: boolean;
  createdAt: string;
};
