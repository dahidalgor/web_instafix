export function whatsappConfiguration() {
  const required = [
    'WASAPFLOW_PARTNER_KEY',
    'WASAPFLOW_WEBHOOK_SECRET',
    'WHATSAPP_TEMPLATE_INITIAL',
    'WHATSAPP_TEMPLATE_CONFIRMED',
    'WHATSAPP_TEMPLATE_DAY_BEFORE',
    'WHATSAPP_TEMPLATE_SAME_DAY',
  ];
  const missing = required.filter((key) => !process.env[key]);
  return {
    enabled: process.env.WHATSAPP_ENABLED === 'true',
    configured: !missing.length,
    missing,
    businessPhone: process.env.WHATSAPP_BUSINESS_PHONE || '+593984703819',
  };
}
export function calConfiguration() {
  // Las versiones de cada endpoint de Cal.com están fijadas en integrations/cal-api.ts.
  const missing = ['CAL_WEBHOOK_SECRET', 'CAL_API_KEY', 'CAL_EVENT_TYPE_ID'].filter(
    (key) => !process.env[key],
  );
  return { configured: !missing.length, missing };
}
