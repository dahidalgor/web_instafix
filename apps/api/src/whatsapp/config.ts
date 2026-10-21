/** Configuración de WhatsApp (Bird). Solo nombres de variables, nunca sus valores. */
export function whatsappConfiguration() {
  const missing = ['BIRD_API_KEY', 'BIRD_WEBHOOK_SECRET', 'WHATSAPP_BUSINESS_PHONE'].filter(
    (key) => !process.env[key]?.trim(),
  );
  return {
    provider: 'BIRD',
    enabled: process.env.WHATSAPP_ENABLED === 'true',
    // Interruptor de emergencia: false = ningún mensaje llega a Bird (se registran como omitidos).
    sendingEnabled: process.env.WHATSAPP_SENDING_ENABLED !== 'false',
    configured: !missing.length,
    missing,
    businessPhone: process.env.WHATSAPP_BUSINESS_PHONE || '+593984703819',
  };
}
export function calConfiguration() {
  const missing = [
    'CAL_WEBHOOK_SECRET',
    'CAL_API_KEY',
    'CAL_API_VERSION',
    'CAL_EVENT_TYPE_ID',
  ].filter((key) => !process.env[key]);
  return { configured: !missing.length, missing };
}
