import { z } from 'zod';
export const registrationSchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    phone: z.string().regex(/^\+[1-9]\d{7,14}$/),
    password: z.string().min(12, 'Usa al menos 12 caracteres').max(128),
  })
  .strict();
export const loginSchema = registrationSchema.omit({ name: true });
