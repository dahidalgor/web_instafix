/**
 * Datos de una reserva de invitado para prellenar «Crear mi cuenta» (solo en esta pestaña,
 * sessionStorage). No es una verificación: la cuenta y la vinculación de la cita requieren
 * igualmente el código OTP enviado a ese mismo WhatsApp.
 */
export const REGISTER_PREFILL_KEY = 'instafix:register-prefill';
export type RegisterPrefill = { firstName: string; lastName: string; phone: string; email: string };

export function takeRegisterPrefill(): RegisterPrefill | null {
  try {
    const raw = sessionStorage.getItem(REGISTER_PREFILL_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<RegisterPrefill>;
    if (typeof value.phone !== 'string' || !value.phone.startsWith('+')) return null;
    return {
      firstName: String(value.firstName ?? '').slice(0, 50),
      lastName: String(value.lastName ?? '').slice(0, 50),
      phone: value.phone.slice(0, 20),
      email: String(value.email ?? '').slice(0, 254),
    };
  } catch {
    return null;
  }
}
export function clearRegisterPrefill() {
  try {
    sessionStorage.removeItem(REGISTER_PREFILL_KEY);
  } catch {
    // Almacenamiento bloqueado: no hay nada que borrar.
  }
}
