/** Avisos de «sin autorización de WhatsApp» (webhook de Cal.com y reserva desde la web). */
export const CAL_CONSENT_ISSUE = 'Falta autorización de WhatsApp en Cal.com';
export const WEB_CONSENT_ISSUE =
  'Sin autorización de WhatsApp: coordinar la ubicación manualmente.';

/** El aviso de la cita es solo por falta de autorización: desaparece al autorizar. */
export const isConsentIssue = (issue: string | null | undefined) =>
  issue === CAL_CONSENT_ISSUE || issue === WEB_CONSENT_ISSUE;
