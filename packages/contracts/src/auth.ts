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
const personName = z
  .string()
  .trim()
  .min(2)
  .max(50)
  .regex(/^[\p{L}\p{M} ’'\-]+$/u, 'Usa letras en tu nombre y apellido')
  .transform(normalizePersonName);
// El backend normaliza el teléfono a E.164; el navegador solo ayuda a escribirlo.
const phoneInput = z.string().trim().min(6).max(30);
const newPassword = z.string().min(12, 'Usa al menos 12 caracteres').max(128);
const code = z.string().regex(/^\d{6}$/, 'Escribe el código de 6 dígitos');
const token = z.string().regex(/^[a-f0-9]{64}$/, 'Enlace inválido');
export const registrationSchema = z
  .object({
    firstName: personName,
    lastName: personName,
    email: emailSchema,
    phone: phoneInput,
    password: newPassword,
  })
  .strict();
export const loginSchema = z
  .object({ phone: phoneInput, password: z.string().min(1).max(128) })
  .strict();
export const emailRequestSchema = z.object({ email: emailSchema }).strict();
export const phoneRequestSchema = z.object({ phone: phoneInput }).strict();
export const verifyPhoneSchema = z.object({ verificationId: z.string().uuid(), code }).strict();
export const resendVerificationSchema = z.object({ verificationId: z.string().uuid() }).strict();
export const tokenSchema = z.object({ token }).strict();
export const completeResetSchema = z.object({ token, password: newPassword }).strict();
export const changeEmailSchema = z
  .object({ email: emailSchema, password: z.string().min(1).max(128) })
  .strict();
export const changePhoneSchema = z
  .object({ phone: phoneInput, password: z.string().min(1).max(128) })
  .strict();
export const changePasswordSchema = z
  .object({ currentPassword: z.string().min(1).max(128), password: newPassword })
  .strict();
export type VerificationTicket = {
  verificationId: string;
  maskedPhone: string;
  expiresIn: number;
  resendAfter: number;
};
