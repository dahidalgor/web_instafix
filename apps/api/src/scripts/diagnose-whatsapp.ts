import { randomBytes, randomInt } from 'node:crypto';
import { parseArgs } from 'node:util';
import { normalizePhone } from '@instafix/contracts/src/phone';
import { db } from '../database/client';
import { ProviderError } from '../integrations/provider-error';
import { connectedWaba, validWabaId } from '../whatsapp/connection';
import { otpConfiguration, WasapFlowOtpProvider } from '../whatsapp/otp.provider';
import { BRIDGE_BASE, WasapFlowClient } from '../whatsapp/wasapflow.client';

/**
 * Diagnóstico paso a paso del envío por WhatsApp. No imprime claves ni códigos.
 *   pnpm --filter @instafix/api whatsapp:diagnose
 *   pnpm --filter @instafix/api whatsapp:diagnose --to +5939XXXXXXXX --send   (envío real)
 */
const ok = (m: string) => console.log(`  ✓ ${m}`);
const bad = (m: string) => console.log(`  ✗ ${m}`);
const info = (m: string) => console.log(`  · ${m}`);
const problems: string[] = [];
const fail = (m: string) => {
  bad(m);
  problems.push(m);
};

async function main() {
  const { values } = parseArgs({
    options: { to: { type: 'string' }, send: { type: 'boolean', default: false } },
  });
  const env = (k: string) => process.env[k]?.trim() || '';

  console.log('\n1. Variables de entorno');
  info(`NODE_ENV=${env('NODE_ENV') || '(sin definir)'}`);
  const key = env('WASAPFLOW_PARTNER_KEY');
  key
    ? ok(`WASAPFLOW_PARTNER_KEY presente (${key.slice(0, 8)}…, ${key.length} caracteres)`)
    : fail('Falta WASAPFLOW_PARTNER_KEY');
  const base = (env('WASAPFLOW_BASE_URL') || BRIDGE_BASE).replace(/\/+$/, '');
  base === BRIDGE_BASE
    ? ok(`URL base ${base}`)
    : fail(`WASAPFLOW_BASE_URL debe ser ${BRIDGE_BASE}`);
  const wabaEnv = env('WASAPFLOW_WABA_ID');
  if (!wabaEnv) info('WASAPFLOW_WABA_ID vacío: correcto mientras no hayas conectado un número');
  else if (!validWabaId(wabaEnv))
    // Nunca se imprime: suele ser la Partner Key pegada en la variable equivocada.
    fail(
      `WASAPFLOW_WABA_ID no es un ID de WABA (debe ser solo números)${wabaEnv.startsWith('wf_') ? ' y parece una Partner Key: bórralo del .env y rota la clave' : ''}`,
    );
  else ok(`WASAPFLOW_WABA_ID=${wabaEnv}`);
  const otp = otpConfiguration();
  otp.enabled ? ok('WHATSAPP_OTP_ENABLED=true') : fail('WHATSAPP_OTP_ENABLED no es "true"');
  otp.template
    ? ok(`Plantilla OTP: ${otp.template}`)
    : fail('Falta WHATSAPP_TEMPLATE_OTP (nombre exacto de la plantilla de autenticación aprobada)');
  info(
    `Idioma de la plantilla OTP: ${env('WHATSAPP_TEMPLATE_OTP_LANGUAGE') || env('WHATSAPP_TEMPLATE_LANGUAGE') || 'es'} (debe ser el mismo con que Meta la aprobó)`,
  );
  info(
    otp.devConsole
      ? 'Modo desarrollo: los OTP se imprimen en la consola de la API, no se envían por WhatsApp'
      : 'Los OTP se envían por WasapFlow (modo consola desactivado)',
  );
  info(
    `WHATSAPP_ENABLED=${env('WHATSAPP_ENABLED') || '(sin definir)'} (solo afecta a los avisos de citas)`,
  );

  console.log('\n2. Conexión guardada en PostgreSQL');
  const saved = await db.whatsAppConnection.findUnique({ where: { id: 'main' } });
  const active = await connectedWaba();
  if (active) ok(`WABA ${active} (modo ${saved?.connectionMode ?? '?'})`);
  else
    info(
      saved?.wabaId
        ? `Hay una WABA ${saved.wabaId} guardada, pero no coincide con WASAPFLOW_WABA_ID o no está completa`
        : 'No hay conexión guardada todavía (se adopta WASAPFLOW_WABA_ID si WasapFlow la confirma)',
    );

  console.log('\n3. WasapFlow (GET /clients)');
  const bridge = new WasapFlowClient();
  if (key && base === BRIDGE_BASE) {
    try {
      const clients = await bridge.listClients();
      ok(`Partner Key válida. WABAs registradas: ${clients.length}`);
      for (const c of clients)
        info(
          `WABA ${c.waba_id} · estado ${c.status} · modo ${c.connection_mode ?? '(no indicado)'}`,
        );
      const target = clients.find((c) => c.waba_id === wabaEnv);
      if (!clients.length)
        fail(
          'Tu cuenta de WasapFlow no tiene ningún número conectado. Conéctalo en Administración → WhatsApp → Conectar WhatsApp Business',
        );
      if (!wabaEnv || !validWabaId(wabaEnv) || !clients.length) {
      } else if (!target)
        fail(
          `WASAPFLOW_WABA_ID no está en tu cuenta de WasapFlow. Usa uno de los IDs listados arriba o regístrala en WasapFlow.`,
        );
      else if (target.status !== 'active') fail(`La WABA está «${target.status}», no activa`);
      else ok('La WABA configurada está activa: Instafix puede enviar con ella');
    } catch (e) {
      fail(
        `No se pudo consultar WasapFlow: ${e instanceof ProviderError ? e.message : 'error de red'}`,
      );
    }
  } else info('Omitido: falta Partner Key o URL base');

  console.log('\n4. Alta de un número (Embedded Signup)');
  if (key && base === BRIDGE_BASE) {
    try {
      const config = await bridge.signupConfig();
      config.connection_mode === 'coexistence'
        ? ok('Embedded Signup disponible en modo Coexistence')
        : fail(
            `Embedded Signup en modo «${String(config.connection_mode ?? 'sin definir')}»: activa Coexistence en WasapFlow para conectar el número sin quitarlo de la app`,
          );
      // Misma llamada que hace «Conectar WhatsApp Business». La sesión de prueba no se guarda
      // en Instafix y caduca sola; no se muestra la URL completa.
      const session = await bridge.createConnectSession(randomBytes(32).toString('hex'));
      ok(
        `Sesión de conexión creada (${new URL(session.connect_url).origin}, caduca en ${session.expires_in} s): el botón puede abrir WasapFlow`,
      );
    } catch (e) {
      fail(
        `No se pudo leer /embedded-signup/config: ${e instanceof ProviderError ? e.message : 'error de red'}`,
      );
    }
  } else info('Omitido: falta Partner Key o URL base');

  console.log('\n4b. Origen del panel de administración');
  const adminHost = process.env.ADMIN_HOST?.trim();
  const origins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim().replace(/\/$/, ''));
  if (!adminHost) info('ADMIN_HOST no está definido en este entorno (normal en desarrollo)');
  else if (origins.includes(`https://${adminHost}`))
    ok(`https://${adminHost} está en ALLOWED_ORIGINS`);
  else
    fail(
      `https://${adminHost} no está en ALLOWED_ORIGINS: el botón recibirá «Origen no permitido»`,
    );

  console.log('\n5. Envío real de la plantilla OTP');
  const phone = normalizePhone(values.to || '', 'EC');
  if (!values.to) info('Omitido. Añade --to +5939XXXXXXXX --send para enviar un código de prueba');
  else if (!phone) fail('--to no es un número válido');
  else if (!values.send) info(`Simulación para ${phone}. Añade --send para enviar de verdad`);
  else if (problems.length) info('Omitido: corrige primero los puntos marcados con ✗');
  else {
    try {
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      const { messageId } = await new WasapFlowOtpProvider(bridge).sendAuthenticationCode(
        phone,
        code,
      );
      ok(
        `WasapFlow aceptó el mensaje (${messageId}). Revisa el teléfono; aceptado no es entregado.`,
      );
    } catch (e) {
      fail(`Envío rechazado: ${e instanceof ProviderError ? e.message : 'error inesperado'}`);
      info(
        'Meta 132001 = nombre o idioma de plantilla incorrecto · 132000 = parámetros no coinciden',
      );
      info(
        '131047/131026 = destinatario sin WhatsApp o fuera de ventana · 190/10 = token de la WABA inválido en WasapFlow',
      );
    }
  }

  console.log(
    problems.length
      ? `\nResultado: ${problems.length} problema(s). Empieza por el primero:\n  → ${problems[0]}\n`
      : '\nResultado: configuración correcta.\n',
  );
}
main()
  .catch((e) => {
    console.error('Diagnóstico interrumpido:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
