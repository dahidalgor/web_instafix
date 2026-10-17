import { z } from 'zod';
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email('Escribe un correo válido')
  .max(254);
export function normalizePersonName(value: string) {
  return value
    .trim()
    .normalize('NFC')
    .toLocaleLowerCase('es')
    .replace(/\s+/g, ' ')
    .replace(/(^|[\s’'\-])\p{L}/gu, (letter) => letter.toLocaleUpperCase('es'));
}
export const personNameSchema = z
  .string()
  .trim()
  .min(2)
  .max(50)
  .regex(/^[\p{L}\p{M} ’'\-]+$/u, 'Usa letras en tu nombre y apellido')
  .transform(normalizePersonName);
export const registrationSchema = z
  .object({
    firstName: personNameSchema,
    lastName: personNameSchema,
    email: emailSchema,
    phone: z.string().regex(/^\+[1-9]\d{7,14}$/),
    password: z.string().min(12, 'Usa al menos 12 caracteres').max(128),
  })
  .strict();
export const loginSchema = registrationSchema.pick({ phone: true, password: true });
export const emailRequestSchema = z.object({ email: emailSchema }).strict();
export const verifyEmailSchema = z
  .object({
    challengeId: z.string().uuid(),
    code: z.string().regex(/^\d{6}$/, 'Escribe el código de 6 dígitos'),
  })
  .strict();
export const resetPasswordSchema = verifyEmailSchema.extend({
  password: z.string().min(12).max(128),
});
