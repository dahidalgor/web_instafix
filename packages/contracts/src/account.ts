export type UserRole = 'CUSTOMER' | 'ADMIN' | 'TECHNICIAN';
/** Roles del equipo administrativo de Instafix. */
export const staffRoles = ['ADMIN', 'TECHNICIAN'] as const;
export const isStaff = (role?: string | null) => role === 'ADMIN' || role === 'TECHNICIAN';
export type AccountUser = {
  id: string;
  name: string;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone: string;
  role: UserRole;
  active?: boolean;
  phoneVerifiedAt: string | null;
  emailVerifiedAt?: string | null;
};
export type CompletedJob = {
  id: string;
  appointmentId?: string | null;
  title: string;
  device: string;
  completedAt: string;
  warrantyEndsAt: string | null;
  warrantyTerms: string;
  priceMinor: number;
  currency: string;
};
