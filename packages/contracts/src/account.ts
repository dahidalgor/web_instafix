export type AccountUser = {
  id: string;
  name: string;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone: string;
  role: 'CUSTOMER' | 'ADMIN';
  phoneVerifiedAt: string | null;
  emailVerifiedAt?: string | null;
};
export type CompletedJob = {
  id: string;
  title: string;
  device: string;
  completedAt: string;
  warrantyEndsAt: string | null;
  warrantyTerms: string;
  priceMinor: number;
  currency: string;
};
