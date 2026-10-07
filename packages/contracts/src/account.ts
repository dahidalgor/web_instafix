export type AccountUser = {
  id: string;
  name: string;
  phone: string;
  role: 'CUSTOMER' | 'ADMIN';
  phoneVerifiedAt: string | null;
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
