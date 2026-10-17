import type { OfferingInput } from '@instafix/contracts';
export type Equipment = { id: string; name: string; category: string };
export type ServiceDraft = OfferingInput & { id?: string };
export type RunAction = (action: () => Promise<void>) => Promise<void>;
export const emptyService: ServiceDraft = {
  title: '',
  equipmentId: '',
  description: '',
  priceMinor: 0,
  durationMinutes: 60,
  warrantyDays: 0,
  availability: 'UNAVAILABLE',
  media: [],
  cover: null,
};
