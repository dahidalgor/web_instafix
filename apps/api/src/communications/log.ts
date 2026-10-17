import { maskEmail, maskPhone } from '@instafix/contracts/src/phone';
import { db } from '../database/client';

export type CommunicationEntry = {
  channel: 'EMAIL' | 'WHATSAPP';
  provider: string;
  kind: string;
  recipient: string;
  status: 'ACCEPTED' | 'FAILED';
  providerMessageId?: string | null;
  error?: string | null;
  appointmentId?: string | null;
  userId?: string | null;
};

export const maskRecipient = (recipient: string) =>
  recipient.includes('@') ? maskEmail(recipient) : maskPhone(recipient);

/**
 * Historial de comunicaciones. El destinatario siempre se enmascara y el error se limita a
 * un texto propio: nunca se guardan códigos, tokens, contraseñas ni respuestas del proveedor.
 */
export async function logCommunication(entry: CommunicationEntry) {
  try {
    await db.communicationLog.create({
      data: {
        ...entry,
        recipient: maskRecipient(entry.recipient),
        error: entry.error?.slice(0, 300) ?? null,
      },
    });
  } catch {
    // El historial no debe convertir un envío aceptado en un error para el usuario.
    console.error('No se pudo registrar la comunicación');
  }
}
