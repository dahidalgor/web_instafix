import { ServiceUnavailableException } from '@nestjs/common';
import nodemailer from 'nodemailer';

export function assertMailConfigured() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_FROM) {
    throw new ServiceUnavailableException(
      'El envío de correos aún no está configurado. Inténtalo más tarde.',
    );
  }
}

export async function sendCode(email: string, code: string, purpose: string) {
  assertMailConfigured();
  const port = Number(process.env.SMTP_PORT || 587);
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    requireTLS: true,
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
      : undefined,
    connectionTimeout: 10000,
    socketTimeout: 15000,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  try {
    await transport.sendMail({
      from: process.env.SMTP_FROM,
      to: email,
      subject:
        purpose === 'REGISTER'
          ? 'Verifica tu cuenta de InstaFix'
          : 'Recupera tu contraseña de InstaFix',
      text: `Tu código de InstaFix es: ${code}\n\nCaduca en 10 minutos y solo puede usarse una vez. Si no solicitaste este código, ignora este correo.`,
    });
  } catch {
    throw new ServiceUnavailableException(
      'No pudimos enviar el correo. Inténtalo de nuevo más tarde.',
    );
  } finally {
    transport.close();
  }
}
