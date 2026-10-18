import { ServiceUnavailableException } from '@nestjs/common';
import nodemailer from 'nodemailer';
import { logCommunication } from '../communications/log';
import type { EmailMessage } from './templates';

/** Contrato del proveedor: cambiar de Brevo no afecta a la lógica de negocio. */
export interface EmailProvider {
  readonly name: string;
  send(to: string, message: EmailMessage): Promise<{ messageId: string | null }>;
}

export function mailStatus() {
  const required = ['SMTP_HOST', 'SMTP_FROM', 'SMTP_USER', 'SMTP_PASSWORD'] as const;
  const missing: string[] = required.filter((key) => !process.env[key]?.trim());
  const port = Number(process.env.SMTP_PORT || 587);
  const validPort = Number.isInteger(port) && port > 0 && port <= 65535;
  if (!validPort) missing.push('SMTP_PORT');
  return {
    configured: missing.length === 0,
    missing: [...new Set(missing)],
    validPort,
    provider: providerName(),
    replyTo: Boolean(process.env.SMTP_REPLY_TO?.trim()),
    appointmentEmails: appointmentEmailsEnabled(),
  };
}

/**
 * Avisos de citas por correo. Explícito: «true»/«false». Sin valor, se activan solo si Cal.com
 * ya no puede escribir al cliente (CAL_ATTENDEE_RELAY_EMAIL), para no duplicar correos.
 */
export const appointmentEmailsEnabled = () =>
  // Activados salvo «false» explícito: Cal.com nunca recibe el correo del cliente (buzón
  // puente o remitente de Instafix), así que Instafix es el único que le escribe.
  process.env.APPOINTMENT_EMAILS_ENABLED?.trim().toLowerCase() !== 'false';

const providerName = () =>
  /brevo|sendinblue/i.test(process.env.SMTP_HOST || '') ? 'BREVO' : 'SMTP';

export function assertMailConfigured() {
  if (!mailStatus().configured) {
    throw new ServiceUnavailableException(
      'El envío de correos aún no está configurado. Inténtalo más tarde.',
    );
  }
}

function mailTransport() {
  assertMailConfigured();
  const port = Number(process.env.SMTP_PORT || 587);
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    requireTLS: true,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
    connectionTimeout: 10000,
    socketTimeout: 15000,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
}

/** SMTP de Brevo. Un 250 significa «Brevo aceptó el mensaje», no que llegó a la bandeja. */
export class SmtpEmailProvider implements EmailProvider {
  get name() {
    return providerName();
  }
  async send(to: string, message: EmailMessage) {
    const transport = mailTransport();
    try {
      const info = await transport.sendMail({
        from: process.env.SMTP_FROM,
        to,
        replyTo: process.env.SMTP_REPLY_TO?.trim() || undefined,
        ...message,
      });
      if (!info.accepted?.length || info.rejected?.length)
        throw new Error('Destinatario rechazado por el servidor SMTP');
      return { messageId: info.messageId || null };
    } finally {
      transport.close();
    }
  }
}

let provider: EmailProvider = new SmtpEmailProvider();
/** Solo para pruebas y futuros proveedores. */
export function setEmailProvider(next: EmailProvider) {
  const previous = provider;
  provider = next;
  return previous;
}

/** Comprueba TLS y autenticación; no envía un correo ni garantiza entrega en bandeja. */
export async function verifyMailConnection() {
  const transport = mailTransport();
  try {
    await transport.verify();
    return {
      ok: true,
      message:
        'Conexión SMTP y autenticación correctas. Falta comprobar la entrega con un correo de prueba.',
    };
  } catch {
    throw new ServiceUnavailableException(
      'No se pudo conectar al correo. Revisa host, puerto, usuario y contraseña SMTP.',
    );
  } finally {
    transport.close();
  }
}

export class EmailDeliveryError extends ServiceUnavailableException {
  constructor(public readonly reason = 'Envío rechazado o sin respuesta') {
    super('No pudimos enviar el correo. Inténtalo de nuevo más tarde.');
  }
}

/** Motivo SMTP legible (p. ej. «550 sender not verified»), sin direcciones ni credenciales. */
export function smtpReason(error: unknown) {
  const e = error as { responseCode?: number; response?: string; code?: string; message?: string };
  const text = [e?.responseCode, e?.response || e?.message, e?.code].filter(Boolean).join(' · ');
  return (text || 'Envío rechazado o sin respuesta')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[correo]')
    .slice(0, 300);
}

/**
 * Único punto de envío de correo. Registra el resultado y lanza EmailDeliveryError si el
 * proveedor no acepta el mensaje: los llamadores nunca deben afirmar que se envió.
 */
export async function sendEmail(input: {
  to: string;
  kind: string;
  message: EmailMessage;
  userId?: string | null;
  appointmentId?: string | null;
}) {
  const base = {
    channel: 'EMAIL' as const,
    provider: provider.name,
    kind: input.kind,
    recipient: input.to,
    userId: input.userId,
    appointmentId: input.appointmentId,
  };
  try {
    const result = await provider.send(input.to, input.message);
    await logCommunication({ ...base, status: 'ACCEPTED', providerMessageId: result.messageId });
    return result;
  } catch (error) {
    const reason =
      error instanceof ServiceUnavailableException ? 'SMTP sin configurar' : smtpReason(error);
    await logCommunication({ ...base, status: 'FAILED', error: reason });
    if (error instanceof ServiceUnavailableException) throw error;
    throw new EmailDeliveryError(reason);
  }
}
