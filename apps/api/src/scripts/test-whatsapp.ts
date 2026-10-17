import { randomInt } from 'node:crypto';
import { parseArgs } from 'node:util';
import { WasapFlowOtpProvider } from '../whatsapp/otp.provider';
import { normalizePhone } from '@instafix/contracts/src/phone';
import { db } from '../database/client';
import { requireConnectedWaba } from '../whatsapp/connection';
import { WasapFlowClient } from '../whatsapp/wasapflow.client';
import { WhatsAppService } from '../whatsapp/whatsapp.service';

// Proceso independiente: nunca inicia workers ni procesa citas de otros clientes.
async function main() {
  const { values } = parseArgs({
    options: {
      to: { type: 'string' },
      send: { type: 'boolean', default: false },
      otp: { type: 'boolean', default: false },
    },
  });
  const phone = normalizePhone(values.to || '', 'EC');
  if (!phone || phone === (process.env.WHATSAPP_BUSINESS_PHONE || '+593984703819'))
    throw new Error('Indica --to con tu teléfono de prueba, distinto al número empresarial');
  if (values.otp) {
    // Prueba de la plantilla AUTHENTICATION: código aleatorio que no valida ninguna cuenta.
    console.log(
      `Destinatario de prueba: ${phone}\nPlantilla OTP: ${process.env.WHATSAPP_TEMPLATE_OTP || '(sin configurar)'}`,
    );
    if (!values.send) {
      console.log('Simulación: no se envió nada. Añade --send con WHATSAPP_OTP_ENABLED=true.');
      return;
    }
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const { messageId } = await new WasapFlowOtpProvider(
      new WasapFlowClient(),
    ).sendAuthenticationCode(phone, code);
    console.log(
      `WasapFlow aceptó la plantilla OTP: ${messageId}. Comprueba la recepción en el teléfono y el estado en el panel.`,
    );
    return;
  }
  const text = 'Prueba de integración de InstaFix ✅ Este mensaje no corresponde a una cita real.';
  console.log(`Destinatario de prueba: ${phone}\n${text}`);
  if (!values.send) {
    console.log(
      'Simulación: no se envió nada. Para enviar utiliza --send, con la conexión activada y un mensaje entrante de ese teléfono en las últimas 24 horas.',
    );
    return;
  }
  await requireConnectedWaba(new WasapFlowClient());
  const id = await new WhatsAppService(new WasapFlowClient()).replyText(phone, text);
  console.log(
    `WasapFlow aceptó el mensaje: ${id}. Comprueba la entrega en el teléfono y en el panel.`,
  );
}
main()
  .catch(() => {
    console.error(
      'No se pudo realizar la prueba. Revisa conexión Coexistence, configuración, habilitación y ventana de 24 horas.',
    );
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
