import { normalizePhone } from '@instafix/contracts/src/phone';

export type BookingOwner = { id: string; name: string; phone: string; email: string | null };
export type IdentityIssue = 'INVALID_REFERENCE' | 'OWNER_CONFLICT' | 'PHONE_MISMATCH' | 'EMAIL_MISMATCH';

/** El contexto procede de una sesión; los campos editables de Cal no deciden el propietario. */
export function bookingIdentity(input: {
  owner: BookingOwner | null;
  invalidReference: boolean;
  ownerConflict: boolean;
  phone: unknown;
  email?: string;
  name: string;
}) {
  const suppliedPhone = typeof input.phone === 'string' ? normalizePhone(input.phone, 'EC') : null;
  const ownerPhone = input.owner ? normalizePhone(input.owner.phone, 'EC') : null;
  const suppliedEmail = input.email?.trim().toLowerCase();
  let issue: IdentityIssue | null = null;
  if (input.invalidReference) issue = 'INVALID_REFERENCE';
  else if (input.ownerConflict) issue = 'OWNER_CONFLICT';
  else if (input.owner && input.phone != null && input.phone !== '' && suppliedPhone !== ownerPhone) issue = 'PHONE_MISMATCH';
  else if (input.owner && suppliedEmail && suppliedEmail !== input.owner.email?.trim().toLowerCase()) issue = 'EMAIL_MISMATCH';
  return {
    userId: input.owner?.id ?? null,
    contactName: input.owner?.name ?? input.name,
    contactPhone: input.owner ? ownerPhone || '' : suppliedPhone || '',
    bookingIdentityIssue: issue,
  };
}

export const bookingIdentityMessage =
  'Los datos de contacto de Cal.com no coinciden con la cuenta o su referencia no es válida. Revisar antes de confirmar o enviar mensajes.';
