/** HTML de correo: tablas e inline CSS para Outlook, Gmail y clientes móviles. */
const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const assetSite = 'https://instafix.ec';
export const webUrl = () =>
  (process.env.PUBLIC_WEB_URL || process.env.WEB_ORIGIN || assetSite).replace(/\/$/, '');

export type EmailMessage = { subject: string; text: string; html: string };
type Detail = { label: string; value: string; muted?: boolean };

export function brandedEmail(input: {
  subject: string;
  /** Línea superior opcional, por ejemplo «✓ Tu cita está confirmada». */
  badge?: string;
  intro: string;
  paragraphs: string[];
  details?: Detail[];
  note?: string;
  action?: { label: string; url: string };
  secondary?: string;
}): EmailMessage {
  const site = webUrl();
  const p = (text: string) => `<p style="margin:0 0 18px;line-height:1.65">${escape(text)}</p>`;
  const details = (input.details ?? [])
    .map(
      (d) =>
        `<tr><td style="padding:12px 16px;border-bottom:1px solid #ece6f1"><span style="display:block;font-size:12px;letter-spacing:.6px;text-transform:uppercase;color:#7a7088">${escape(d.label)}</span><span style="display:block;margin-top:4px;font-size:17px;font-weight:bold;color:${d.muted ? '#7a7088' : '#17142f'}${d.muted ? ';text-decoration:line-through' : ''}">${escape(d.value)}</span></td></tr>`,
    )
    .join('');
  const button = input.action
    ? `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:8px 0 6px"><tr><td bgcolor="#981268" style="border-radius:8px;text-align:center"><a href="${escape(input.action.url)}" style="display:inline-block;padding:15px 24px;border:1px solid #981268;border-radius:8px;color:#ffffff;text-decoration:none;font-weight:bold">${escape(input.action.label)}</a></td></tr></table>`
    : '';
  const text = [
    'INSTAFIX',
    input.badge,
    input.intro,
    ...input.paragraphs,
    ...(input.details ?? []).map((d) => `${d.label}: ${d.value}`),
    input.note,
    input.action ? `${input.action.label}: ${input.action.url}` : '',
    input.secondary,
    'Instafix · Servicio técnico a domicilio',
    'WhatsApp: +593 98 470 3819',
    `${site}/#contacto`,
  ]
    .filter(Boolean)
    .join('\n\n');
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${escape(input.subject)}</title></head><body style="margin:0;padding:0;background:#f4f1f7;color:#181632;font-family:Arial,Helvetica,sans-serif"><div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${escape(input.badge || input.intro)}</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f1f7"><tr><td align="center" style="padding:24px 12px"><!--[if mso]><table role="presentation" width="600"><tr><td><![endif]--><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#ffffff;border:1px solid #e4deeb;border-radius:20px"><tr><td style="padding:26px 28px;background:#17142f;border-radius:20px 20px 0 0"><img src="${assetSite}/images/instafix-logo-128.png" width="52" height="52" alt="Logo Instafix" style="display:inline-block;vertical-align:middle;border:0;border-radius:50%"><span style="display:inline-block;vertical-align:middle;padding-left:14px;color:#ffffff;font-size:26px;font-weight:bold">Insta<span style="color:#f0a6d2">Fix</span></span></td></tr><tr><td style="padding:30px 26px">${input.badge ? `<p style="margin:0 0 10px;color:#1b7a4b;font-size:15px;font-weight:bold">${escape(input.badge)}</p>` : ''}<h1 style="font-size:25px;line-height:1.3;margin:0 0 20px;color:#17142f">${escape(input.intro)}</h1>${input.paragraphs.map(p).join('')}${details ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:6px 0 22px;background:#f8f5fa;border:1px solid #ece6f1;border-radius:12px">${details}</table>` : ''}${input.note ? `<p style="margin:0 0 22px;padding:14px 16px;background:#fff8e6;border-left:3px solid #d9a21b;border-radius:0 8px 8px 0;font-size:14px;line-height:1.6;color:#4d4436">${escape(input.note)}</p>` : ''}${button}${input.secondary ? `<p style="font-size:14px;line-height:1.6;color:#4d4560;margin:16px 0 0">${escape(input.secondary)}</p>` : ''}<p style="font-size:13px;line-height:1.6;color:#625970;margin:24px 0 0">¿Necesitas ayuda? <a href="https://wa.me/593984703819" style="color:#88115f">Escríbenos por WhatsApp</a>: +593 98 470 3819.</p></td></tr><tr><td style="padding:22px 26px;border-top:1px solid #e4deeb;color:#625970;font-size:12px;line-height:1.7"><strong style="color:#17142f">Instafix</strong><br>Servicio técnico a domicilio · Ecuador<br><a href="${site}/#contacto" style="color:#88115f">Contacto</a> · <a href="${site}/#garantia" style="color:#88115f">Políticas de garantía</a></td></tr></table><!--[if mso]></td></tr></table><![endif]--></td></tr></table></body></html>`;
  return { subject: input.subject, text, html };
}

const capitalize = (value: string) => value.charAt(0).toLocaleUpperCase('es') + value.slice(1);
export function appointmentDate(date: Date, timeZone = 'America/Guayaquil') {
  return capitalize(
    new Intl.DateTimeFormat('es-EC', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      timeZone,
    }).format(date),
  );
}
export function appointmentTime(date: Date, timeZone = 'America/Guayaquil') {
  return new Intl.DateTimeFormat('es-EC', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  }).format(date);
}
const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

export function emailVerificationEmail(input: { name: string; url: string }) {
  return brandedEmail({
    subject: 'Verifica tu correo en Instafix',
    intro: `Hola ${firstName(input.name)}, verifica tu correo`,
    paragraphs: [
      'Pulsa el botón para confirmar que este correo te pertenece. Así también podrás recuperar tu contraseña por correo.',
      'El enlace caduca en 24 horas y solo puede usarse una vez. Si no lo solicitaste, ignora este mensaje.',
    ],
    action: { label: 'Verificar mi correo', url: input.url },
  });
}

export function passwordResetEmail(input: { name: string; url: string }) {
  return brandedEmail({
    subject: 'Restablece tu contraseña de Instafix',
    intro: `Hola ${firstName(input.name)}, recupera tu acceso`,
    paragraphs: [
      'Recibimos una solicitud para cambiar la contraseña de tu cuenta. Pulsa el botón para elegir una nueva.',
      'El enlace caduca en 30 minutos y solo puede usarse una vez. Si no fuiste tú, ignora este correo: tu contraseña no cambiará.',
    ],
    action: { label: 'Elegir nueva contraseña', url: input.url },
  });
}

export type AppointmentEmailData = {
  name: string;
  startsAt: string;
  timeZone: string;
  request: string;
  /** Obsoleto: el correo de creación ya no anuncia confirmación. */
  confirmed?: boolean;
  technicianName?: string | null;
  guest: boolean;
  previousStartsAt?: string | null;
};
const visitNote =
  'Ten en cuenta que, debido a trabajos anteriores o condiciones de ruta, la hora de llegada puede variar ligeramente.';
function appointmentAccess(guest: boolean) {
  return guest
    ? {
        secondary:
          'Crea tu cuenta en instafix.ec con este mismo número de WhatsApp para consultar y gestionar tus citas.',
        action: { label: 'Crear mi cuenta', url: `${webUrl()}/#cuenta` },
      }
    : { action: { label: 'Ver mi cita', url: `${webUrl()}/#cuenta` } };
}
function requestDetails(data: AppointmentEmailData, previous = false): Detail[] {
  const starts = new Date(data.startsAt);
  return [
    ...(previous && data.previousStartsAt
      ? [
          {
            label: 'Fecha anterior',
            value: `${appointmentDate(new Date(data.previousStartsAt), data.timeZone)} · ${appointmentTime(new Date(data.previousStartsAt), data.timeZone)}`,
            muted: true,
          },
        ]
      : []),
    { label: previous ? 'Nueva fecha' : 'Fecha', value: appointmentDate(starts, data.timeZone) },
    {
      label: previous ? 'Nueva hora estimada' : 'Hora estimada',
      value: appointmentTime(starts, data.timeZone),
    },
    // El cliente describe su necesidad; el diagnóstico y el servicio los define el técnico.
    { label: 'Solicitud', value: `“${data.request}”` },
  ];
}

/** Al agendar: la visita queda pendiente hasta que un técnico la confirme. Nunca dice «confirmada». */
export function appointmentCreatedEmail(data: AppointmentEmailData) {
  return brandedEmail({
    subject: 'Recibimos tu solicitud de visita · Instafix',
    badge: '✓ Solicitud recibida',
    intro: `Hola ${firstName(data.name)}, recibimos tu solicitud de visita`,
    paragraphs: [
      data.guest
        ? 'Tu solicitud de visita fue creada correctamente y está pendiente de confirmación.'
        : 'Tu solicitud quedó agendada y está pendiente de confirmación.',
      'Un técnico de Instafix revisará tu solicitud y te avisaremos cuando confirme la visita. También te escribiremos por WhatsApp para pedirte la ubicación donde debe llegar.',
    ],
    details: [...requestDetails(data), { label: 'Estado', value: 'Pendiente de confirmación' }],
    note: visitNote,
    ...appointmentAccess(data.guest),
  });
}

/** Un técnico confirmó la visita y quedó asignado. */
export function appointmentConfirmedEmail(data: AppointmentEmailData) {
  return brandedEmail({
    subject: 'Tu visita está confirmada ✓ · Instafix',
    badge: '✓ Tu visita está confirmada',
    intro: `Hola ${firstName(data.name)}, tu visita está confirmada`,
    paragraphs: [
      data.technicianName
        ? `${data.technicianName} será tu técnico y irá hasta tu domicilio en el horario agendado.`
        : 'Un técnico de Instafix irá hasta tu domicilio en el horario agendado.',
    ],
    details: [
      ...requestDetails(data).slice(0, 2),
      ...(data.technicianName ? [{ label: 'Técnico asignado', value: data.technicianName }] : []),
      ...requestDetails(data).slice(2),
    ],
    note: `Tu técnico se pondrá en contacto contigo antes de llegar. ${visitNote}`,
    ...appointmentAccess(data.guest),
  });
}

export function appointmentRescheduledEmail(data: AppointmentEmailData) {
  return brandedEmail({
    subject: 'Tu cita con Instafix fue reprogramada',
    badge: '↻ Tu cita fue reprogramada',
    intro: `Hola ${firstName(data.name)},`,
    paragraphs: ['Actualizamos la fecha de tu visita. Estos son los nuevos datos:'],
    details: requestDetails(data, true),
    note: `Tu técnico se pondrá en contacto contigo antes de llegar. ${visitNote}`,
    ...appointmentAccess(data.guest),
  });
}

export function appointmentCancelledEmail(data: AppointmentEmailData) {
  return brandedEmail({
    subject: 'Tu cita con Instafix fue cancelada',
    badge: '✕ Tu cita fue cancelada',
    intro: `Hola ${firstName(data.name)},`,
    paragraphs: [
      'La siguiente visita fue cancelada y el horario quedó liberado.',
      'Si quieres atender tu equipo en otro momento, puedes agendar una nueva cita cuando lo necesites.',
    ],
    details: requestDetails(data),
    action: { label: 'Agendar otra cita', url: `${webUrl()}/#agenda` },
  });
}

export function testEmail() {
  return brandedEmail({
    subject: 'Prueba de correo de Instafix',
    intro: 'Prueba de envío',
    paragraphs: [
      'Este mensaje confirma que Instafix pudo entregar un correo a Brevo. Revisa si llegó a la bandeja de entrada o a spam, y consulta los encabezados Authentication-Results (SPF, DKIM y DMARC).',
    ],
  });
}
