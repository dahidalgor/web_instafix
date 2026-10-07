import { z } from 'zod';
export const requestSchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    phone: z.string().regex(/^\+[1-9]\d{7,14}$/, 'Usa código de país, por ejemplo +593991234567'),
    offeringId: z.string().min(1).max(100),
    problem: z.string().trim().min(5).max(1000),
    consent: z.literal(true),
  })
  .strict();
export type ServiceRequestInput = z.infer<typeof requestSchema>;
export const catalog = [
  {
    id: 'ps4-maintenance',
    category: 'Consolas',
    device: 'PlayStation 4',
    title: 'Mantenimiento preventivo',
    priceMinor: 2000,
    durationMinutes: 90,
  },
  {
    id: 'ps5-maintenance',
    category: 'Consolas',
    device: 'PlayStation 5',
    title: 'Mantenimiento preventivo',
    priceMinor: 2500,
    durationMinutes: 90,
  },
  {
    id: 'laptop-diagnosis',
    category: 'Computadoras',
    device: 'Laptop',
    title: 'Diagnóstico técnico',
    priceMinor: 1500,
    durationMinutes: 60,
  },
] as const;
export type RequestReceipt = {
  reference: string;
  status: 'PENDIENTE_UBICACION';
  expiresAt: string;
};
