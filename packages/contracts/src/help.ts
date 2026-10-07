import { z } from 'zod';
export const helpRequestSchema = z
  .object({
    name: z.string().trim().min(2, 'Escribe tu nombre').max(100),
    phone: z.string().regex(/^\+[1-9]\d{7,14}$/, 'Revisa el número de teléfono'),
    device: z.string().trim().min(2, 'Indica qué equipo tienes').max(100),
    problem: z.string().trim().min(5, 'Cuéntanos un poco más sobre tu consulta').max(1000),
    consent: z.literal(true),
  })
  .strict();
export type HelpReceipt = { reference: string; status: 'PENDIENTE_ASESORIA' };
