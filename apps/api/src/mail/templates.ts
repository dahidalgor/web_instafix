/** HTML de correo: tablas e inline CSS para Outlook, Gmail y clientes móviles. */
const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const site = 'https://instafix.ec';
export function brandedEmail(input: {
  subject: string;
  intro: string;
  paragraphs: string[];
  code?: string;
  action: string;
  page: 'cuenta' | 'contacto';
}) {
  const url = `${site}/#${input.page}`;
  const paragraphs = input.paragraphs
    .map((p) => `<p style="margin:0 0 20px;line-height:1.65">${escape(p)}</p>`)
    .join('');
  return {
    subject: input.subject,
    text: [
      input.intro,
      ...input.paragraphs,
      input.code ? `Tu código: ${input.code}` : '',
      `${input.action}: ${url}`,
      'InstaFix · Tecnología que sigue contigo.',
      'WhatsApp: +593 98 470 3819',
      `${site}/#contacto`,
    ]
      .filter(Boolean)
      .join('\n\n'),
    html: `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(input.subject)}</title></head><body style="margin:0;padding:0;background:#f4f1f7;color:#181632;font-family:Arial,Helvetica,sans-serif"><div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${escape(input.intro)}</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f1f7"><tr><td align="center" style="padding:24px 12px"><!--[if mso]><table role="presentation" width="600"><tr><td><![endif]--><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#ffffff;border:1px solid #e4deeb;border-radius:20px"><tr><td style="padding:28px;background:#17142f;border-radius:20px 20px 0 0"><img src="${site}/images/instafix-logo.png" width="56" height="56" alt="Logo InstaFix" style="display:inline-block;vertical-align:middle;border:0;border-radius:50%"><span style="display:inline-block;vertical-align:middle;padding-left:14px;color:#ffffff;font-size:27px;font-weight:bold">Insta<span style="color:#f0a6d2">Fix</span></span></td></tr><tr><td style="padding:30px 24px"><h1 style="font-size:26px;line-height:1.25;margin:0 0 22px;color:#17142f">${escape(input.intro)}</h1>${paragraphs}${input.code ? `<p style="padding:20px 8px;margin:24px 0;text-align:center;background:#f4eef7;color:#88115f;font-size:32px;font-weight:bold;letter-spacing:6px">${escape(input.code)}</p>` : ''}<table role="presentation" cellspacing="0" cellpadding="0"><tr><td bgcolor="#981268" style="border-radius:8px;text-align:center"><a href="${url}" style="display:inline-block;padding:15px 22px;border:1px solid #981268;border-radius:8px;color:#ffffff;text-decoration:none;font-weight:bold">${escape(input.action)}</a></td></tr></table><p style="font-size:13px;line-height:1.6;color:#625970;margin:24px 0 0">¿Necesitas ayuda? <a href="https://wa.me/593984703819" style="color:#88115f">Escríbenos por WhatsApp</a>: +593 98 470 3819.</p></td></tr><tr><td style="padding:22px 24px;border-top:1px solid #e4deeb;color:#625970;font-size:12px;line-height:1.7">InstaFix · Tecnología que sigue contigo.<br>Servicios técnicos a domicilio · Ecuador<br><a href="${site}/#contacto" style="color:#88115f">Contacto</a> · <a href="${site}/#garantia" style="color:#88115f">Políticas de garantía</a></td></tr></table><!--[if mso]></td></tr></table><![endif]--></td></tr></table></body></html>`,
  };
}
export function codeEmail(code: string, purpose: string) {
  if (!/^\d{6}$/.test(code)) throw new Error('Código de correo inválido');
  const register = purpose === 'REGISTER';
  return brandedEmail({
    subject: register ? 'Verifica tu cuenta de InstaFix' : 'Recupera tu contraseña de InstaFix',
    intro: register ? 'Bienvenido a InstaFix' : 'Recupera el acceso a tu cuenta',
    paragraphs: [
      register
        ? 'Estás a un paso de consultar tus citas, servicios y garantías. Introduce este código en la ventana donde comenzaste tu registro para verificar tu correo.'
        : 'Introduce este código en la ventana donde solicitaste recuperar tu contraseña. Después podrás elegir una nueva contraseña.',
      'El código caduca en 10 minutos y solo puede usarse una vez. No lo compartas. Si no lo solicitaste, ignora este correo.',
      'Si ya tienes el formulario abierto, vuelve a él. El botón abre Mi cuenta; no verifica el código automáticamente.',
    ],
    code,
    action: 'Abrir Mi cuenta',
    page: 'cuenta',
  });
}
/** Lista para revisión; Cal.com sigue siendo el único emisor de confirmaciones. */
export function appointmentEmail(input: { name: string; description: string; startsAt: Date }) {
  const date = new Intl.DateTimeFormat('es-EC', {
    dateStyle: 'long',
    timeStyle: 'short',
    hourCycle: 'h23',
    timeZone: 'America/Guayaquil',
  }).format(input.startsAt);
  return brandedEmail({
    subject: 'Tu cita con InstaFix está confirmada',
    intro: `¡Listo, ${input.name}!`,
    paragraphs: [
      `Tu cita para ${input.description} está confirmada para el ${date} (hora de Ecuador).`,
      'El técnico se comunicará contigo por WhatsApp cuando esté próximo a llegar.',
      'La hora agendada corresponde a un horario estimado de llegada. Debido a la duración de servicios anteriores y a los tiempos de traslado, podría presentarse una ligera variación. Agradecemos mucho tu comprensión y paciencia.',
    ],
    action: 'Contactar con InstaFix',
    page: 'contacto',
  });
}
