import { HttpException } from '@nestjs/common';
import type { BookingErrorCode } from '@instafix/contracts';

export const bookingMessages: Record<BookingErrorCode, string> = {
  ACCOUNT_EXISTS:
    'Ya existe una cuenta asociada a este número de WhatsApp. Inicia sesión para agendar tu cita.',
  INVALID_EMAIL: 'Ese correo no puede recibir mensajes. Revisa que esté bien escrito.',
  SLOT_TAKEN: 'Este horario acaba de dejar de estar disponible. Selecciona otro horario.',
  IN_PROGRESS: 'Estamos procesando tu cita. Espera unos segundos antes de volver a intentarlo.',
  UNCERTAIN:
    'No pudimos comprobar si tu cita quedó registrada. Revisa Mi cuenta en unos minutos o vuelve a intentarlo; no se creará una cita duplicada.',
  PROVIDER_UNAVAILABLE:
    'La agenda no está disponible en este momento. Inténtalo de nuevo en unos minutos.',
  REJECTED:
    'No pudimos registrar la cita con estos datos. Revisa la información o escríbenos por WhatsApp.',
  NOT_CONFIGURED: 'La agenda en línea no está disponible en este momento.',
  NOT_ALLOWED: 'Esta cita ya no admite cambios desde la web. Escríbenos por WhatsApp.',
};

const statusFor: Record<BookingErrorCode, number> = {
  ACCOUNT_EXISTS: 409,
  INVALID_EMAIL: 422,
  SLOT_TAKEN: 409,
  IN_PROGRESS: 409,
  UNCERTAIN: 502,
  PROVIDER_UNAVAILABLE: 503,
  REJECTED: 422,
  NOT_CONFIGURED: 503,
  NOT_ALLOWED: 409,
};

/** Error con un código estable que la web traduce a acciones (iniciar sesión, elegir otro horario…). */
export function bookingError(code: BookingErrorCode, message = bookingMessages[code]) {
  return new HttpException({ statusCode: statusFor[code], code, message }, statusFor[code]);
}
