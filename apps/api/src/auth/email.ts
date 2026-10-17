import { ServiceUnavailableException } from '@nestjs/common';
import nodemailer from 'nodemailer';
import { codeEmail } from '../mail/templates';

export function mailStatus() {
  const required = ['SMTP_HOST', 'SMTP_FROM', 'SMTP_USER', 'SMTP_PASSWORD'] as const;
  const missing: string[] = required.filter((key) => !process.env[key]?.trim());
  const port = Number(process.env.SMTP_PORT || 587);
  const validPort = Number.isInteger(port) && port > 0 && port <= 65535;
  if (!validPort) missing.push('SMTP_PORT');
  return { configured: missing.length === 0, missing: [...new Set(missing)], validPort };
}

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

export async function sendCode(email: string, code: string, purpose: string) {
  const transport = mailTransport();
  try {
    await transport.sendMail({
      from: process.env.SMTP_FROM,
      to: email,
      replyTo: process.env.SMTP_REPLY_TO?.trim() || undefined,
      ...codeEmail(code, purpose),
    });
  } catch {
    throw new ServiceUnavailableException(
      'No pudimos enviar el correo. Inténtalo de nuevo más tarde.',
    );
  } finally {
    transport.close();
  }
}
