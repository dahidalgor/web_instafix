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
  locationLatitude?: number | null;
  locationLongitude?: number | null;
  locationArea?: string | null;
  locationSource?: string | null;
  locationName?: string | null;
  rescheduleCount?: number;
};
export const MAX_RESCHEDULES = 2;

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
  /** GUEST: invitado sin cuenta · EXISTING_ACCOUNT: el número ya tiene cuenta (iniciar sesión). */
  account: 'LINKED' | 'GUEST' | 'EXISTING_ACCOUNT';
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
  /** Calle y sector calculados desde la ubicación del cliente. */
  locationArea: string | null;
  locationLatitude: number | null;
  locationLongitude: number | null;
  locationReceivedAt: string | null;
  /** WHATSAPP (webhook firmado) o STAFF (pegada por el equipo). */
  locationSource?: string | null;
  /** Nombre o dirección del lugar compartido (no es la dirección escrita). */
  locationName?: string | null;
  automationIssue: string | null;
  bookingIdentityIssue: string | null;
  calStatus: string | null;
  assignedTechnician: { id: string; name: string } | null;
  confirmedAt: string | null;
  completedAt: string | null;
  technicianNotes?: string;
  services: PerformedService[];
  /** Participaciones en el sorteo marcadas por el técnico al completar. */
  giveawayEntries: number;
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
/**
 * Edición de un técnico por un administrador. Solo datos de perfil y estado: nunca id, rol,
 * hashes ni relaciones. La contraseña se cambia por su propia acción.
 */
export const staffUpdateSchema = z
  .object({
    firstName: z.string().trim().min(2).max(50).optional(),
    lastName: z.string().trim().min(2).max(50).optional(),
    phone: z.string().trim().min(6).max(30).optional(),
    email: z.union([z.string().trim().toLowerCase().email().max(254), z.literal('')]).optional(),
    active: z.boolean().optional(),
    /** Confirma desactivar aunque tenga citas futuras asignadas (se conservan tal cual). */
    confirmFutureAppointments: z.literal(true).optional(),
    password: z.string().min(12, 'Usa al menos 12 caracteres').max(128).optional(),
  })
  .strict();

/** Orden del listado de citas de administración; el backend lo traduce a campos reales. */
export const appointmentSorts = [
  { id: 'created_desc', label: 'Creación: más recientes primero' },
  { id: 'created_asc', label: 'Creación: más antiguas primero' },
  { id: 'starts_asc', label: 'Fecha de la cita: próximas primero' },
  { id: 'starts_desc', label: 'Fecha de la cita: más lejanas primero' },
] as const;
export type AppointmentSort = (typeof appointmentSorts)[number]['id'];
export const appointmentSortSchema = z
  .enum(appointmentSorts.map((s) => s.id) as [AppointmentSort, ...AppointmentSort[]])
  .default('starts_desc');
export type StaffMember = {
  id: string;
  name: string;
  firstName?: string | null;
  lastName?: string | null;
  phone: string;
  email: string | null;
  role: 'ADMIN' | 'TECHNICIAN';
  active: boolean;
  createdAt: string;
  /** Citas futuras activas asignadas (solo técnicos). */
  upcomingAppointments?: number;
};
