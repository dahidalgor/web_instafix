import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { config } from 'dotenv';
import { birdClient, birdKeyRegion, describeBirdError } from '../whatsapp/bird/bird.client';

config({ path: resolve(process.cwd(), '../../.env') });

/**
 * Prueba (spike) de Bird para el gate de la migración de WhatsApp. No toca WasapFlow ni la base.
 * Solo lectura salvo que se pase --send. Nunca imprime la API key ni números completos.
 *
 *   pnpm --filter @instafix/api bird:spike
 *   pnpm --filter @instafix/api bird:spike --to +5939XXXXXXXX --template <slug> \
 *     [--lang es] [--param valor | --param nombre=valor …] [--from +593…] --send
 *   pnpm --filter @instafix/api bird:spike --message <id>     (estado y línea de tiempo)
 */
const { values } = parseArgs({
  options: {
    to: { type: 'string' },
    from: { type: 'string' },
    template: { type: 'string' },
    lang: { type: 'string', default: 'es' },
    param: { type: 'string', multiple: true, default: [] },
    'button-param': { type: 'string' },
    send: { type: 'boolean', default: false },
    message: { type: 'string' },
    wait: { type: 'string', default: '60' },
  },
});

// Plantillas que Instafix necesita (ver docs/whatsapp-bird.md).
const REQUIRED = [
  'phone_verification',
  'password_reset',
  'appointment_requested',
  'appointment_confirmed',
  'appointment_rescheduled',
  'appointment_cancelled',
  'appointment_reminder',
  'technician_on_the_way',
];

const ok = (m: string) => console.log(`  ✓ ${m}`);
const bad = (m: string) => console.log(`  ✗ ${m}`);
const info = (m: string) => console.log(`  · ${m}`);
const mask = (phone?: string | null) =>
  phone ? `${phone.slice(0, 4)}…${phone.slice(-3)}` : '(sin número)';
type Verdict = 'sí' | 'no' | 'no verificable';
const gate: [string, Verdict, string][] = [];
const record = (item: string, verdict: Verdict, note = '') => gate.push([item, verdict, note]);
const failure = (error: unknown) => {
  const { kind, message } = describeBirdError(error);
  return `${kind}: ${message}`;
};

async function timeline(id: string) {
  const bird = birdClient();
  const message = await bird.whatsapp.get(id);
  info(
    `mensaje ${message.id}: ${message.status}` +
      `${message.sent_at ? ` · enviado ${message.sent_at}` : ''}` +
      `${message.delivered_at ? ` · entregado ${message.delivered_at}` : ''}` +
      `${message.read_at ? ` · leído ${message.read_at}` : ''}`,
  );
  if (message.last_error)
    bad(
      `error ${message.last_error.code}${message.last_error.meta_error_code ? ` (Meta ${message.last_error.meta_error_code})` : ''}: ${message.last_error.description}`,
    );
  const { data } = await bird.whatsapp.listEvents(id);
  for (const event of data as any[])
    info(
      `  ${event.occurred_at ?? ''} ${event.type}${event.error ? ` · ${event.error.code}` : ''}`,
    );
  return message;
}

async function main() {
  console.log('\nBird · spike de WhatsApp para Instafix\n');

  console.log('1. Configuración');
  const region = birdKeyRegion();
  if (!process.env.BIRD_API_KEY?.trim()) {
    bad('Falta BIRD_API_KEY en el .env de la raíz del repositorio (BIRD_API_KEY=bk_…).');
    process.exit(1);
  }
  if (!region) bad('BIRD_API_KEY no tiene el formato bk_<región>_…');
  else ok(`BIRD_API_KEY presente (región «${region}»; la clave no se muestra)`);
  const bird = birdClient();

  if (values.message) {
    console.log('\nEstado de un mensaje');
    await timeline(values.message);
    return;
  }

  console.log('\n2. Autenticación (workspace)');
  try {
    const workspace: any = await bird.workspace.get();
    ok(`clave válida · workspace «${workspace.name}»`);
    record('SDK oficial y autenticación con BIRD_API_KEY', 'sí');
  } catch (error) {
    bad(failure(error));
    record('SDK oficial y autenticación con BIRD_API_KEY', 'no', failure(error));
    return summary();
  }

  console.log('\n3. Cuentas de WhatsApp Business (WABA)');
  try {
    let count = 0;
    for await (const waba of bird.whatsapp.businessAccounts.list() as any) {
      count++;
      info(`${waba.id} · ${waba.name ?? ''} ${waba.status ? `· ${waba.status}` : ''}`);
    }
    if (!count) bad('No hay ninguna WABA conectada a este workspace.');
  } catch (error) {
    bad(failure(error));
  }

  console.log('\n4. Números de WhatsApp');
  const numbers: any[] = [];
  try {
    for await (const number of bird.whatsapp.numbers.list()) numbers.push(number);
  } catch (error) {
    bad(failure(error));
  }
  if (!numbers.length) bad('No hay números de WhatsApp en este workspace.');
  for (const n of numbers)
    info(
      `${n.id} · ${mask(n.phone_number)} · ${n.status} · ámbito ${n.scope}` +
        ` · Business app (Coexistence): ${n.is_on_business_app === undefined ? '¿?' : n.is_on_business_app ? 'sí' : 'no'}` +
        `${n.quality_rating ? ` · calidad ${n.quality_rating}` : ''}` +
        `${n.messaging_limit ? ` · límite ${n.messaging_limit}` : ''}` +
        `${n.finish_setup_url ? ' · tiene un paso pendiente (finish_setup_url en el dashboard)' : ''}` +
        `${n.error ? ` · error ${n.error.code ?? ''}` : ''}`,
    );
  const own = numbers.filter((n) => n.scope === 'workspace');
  const connected = own.filter((n) => n.status === 'connected');
  const business = process.env.WHATSAPP_BUSINESS_PHONE?.trim();
  const instafix = connected.find((n) => n.phone_number === business);
  if (connected.length) ok(`${connected.length} número(s) propio(s) conectado(s)`);
  else bad('Ningún número propio está «connected»: falta el onboarding en Bird.');
  record(
    'Número propio conectado',
    connected.length ? 'sí' : 'no',
    connected.length ? '' : 'onboarding pendiente en Bird → Numbers',
  );
  if (business)
    record(
      `Número de Instafix (${mask(business)}) en Bird`,
      instafix ? 'sí' : 'no',
      instafix ? '' : 'no está conectado en este workspace',
    );
  const coexistence = connected.find((n) => n.is_on_business_app);
  record(
    'Coexistence (app Business + API en el mismo número)',
    coexistence ? 'sí' : connected.length ? 'no' : 'no verificable',
    coexistence
      ? `${mask(coexistence.phone_number)} sigue en la app Business`
      : connected.length
        ? 'los números conectados no están en la app Business'
        : 'requiere conectar el número con «coexistence»',
  );

  console.log('\n5. Plantillas');
  const templates: any[] = [];
  try {
    for await (const t of bird.whatsapp.templates.list() as any) templates.push(t);
  } catch (error) {
    bad(failure(error));
  }
  for (const t of templates) {
    const languages = Array.isArray(t.languages)
      ? t.languages.map((l: any) => `${l.language}:${l.status ?? '?'}`).join(', ')
      : (t.available_languages ?? []).join(', ');
    info(`${t.slug} · ${t.category ?? ''} · ${t.status} · ${t.scope ?? ''} · [${languages}]`);
  }
  const bySlug = new Map(templates.map((t) => [t.slug, t]));
  for (const slug of REQUIRED) {
    const t = bySlug.get(slug);
    if (!t) bad(`falta «${slug}»`);
    else if (t.status !== 'active') bad(`«${slug}» está ${t.status}`);
    else ok(`«${slug}» activa`);
  }
  const active = REQUIRED.filter((slug) => bySlug.get(slug)?.status === 'active');
  record(
    'Plantillas de Instafix aprobadas',
    active.length === REQUIRED.length ? 'sí' : 'no',
    `${active.length}/${REQUIRED.length} activas`,
  );
  record(
    'Plantilla de autenticación gestionada por Bird (bird_otp)',
    bySlug.has('bird_otp') ? 'sí' : 'no verificable',
    bySlug.has('bird_otp') ? '' : 'no aparece en el listado',
  );

  console.log('\n6. Envío real');
  if (!values.send) {
    info('Omitido (solo lectura). Añade --to +593… --template <slug> --send para probarlo.');
    record('Envío real de plantilla', 'no verificable', 'sin --send');
    return summary();
  }
  if (!values.to || !values.template) {
    bad('--send necesita --to y --template');
    process.exit(1);
  }
  const managed = values.template.startsWith('bird_');
  const from = values.from ?? (managed ? undefined : (instafix ?? connected[0])?.phone_number);
  if (!managed && !from) {
    bad('No hay número de origen conectado; pasa --from o conecta el número.');
    process.exit(1);
  }
  const parameters = values.param.map((p) => {
    const at = p.indexOf('=');
    return at > 0 && /^[a-z_][a-z0-9_]*$/.test(p.slice(0, at))
      ? { type: 'text', name: p.slice(0, at), text: p.slice(at + 1) }
      : { type: 'text', text: p };
  });
  const components: any[] = parameters.length ? [{ type: 'body', parameters }] : [];
  if (values['button-param'])
    components.push({
      type: 'button',
      parameters: [{ type: 'text', text: values['button-param'] }],
    });
  try {
    const sent = await bird.whatsapp.send({
      to: values.to,
      ...(from ? { from } : {}),
      template: {
        slug: values.template,
        language: values.lang,
        ...(components.length ? { components } : {}),
      },
    } as any);
    ok(`aceptado por Bird · id ${sent.id} · estado ${sent.status} → ${mask(values.to)}`);
    info('«accepted» no es «entregado»: se consulta el estado real…');
    const deadline = Date.now() + Number(values.wait) * 1000;
    let last = sent.status as string;
    while (Date.now() < deadline && !['delivered', 'failed', 'rejected'].includes(last)) {
      await new Promise((r) => setTimeout(r, 4000));
      last = (await bird.whatsapp.get(sent.id)).status;
    }
    const final = await timeline(sent.id);
    record(
      'Envío real de plantilla',
      final.status === 'delivered' || final.read_at
        ? 'sí'
        : final.status === 'sent'
          ? 'no verificable'
          : 'no',
      `estado final ${final.status}`,
    );
  } catch (error) {
    bad(failure(error));
    record('Envío real de plantilla', 'no', failure(error));
  }
  summary();
}

function summary() {
  record(
    'Webhooks firmados (Standard Webhooks, idempotencia por webhook-id)',
    'no verificable',
    'requiere URL pública registrada en Bird; se prueba con mocks y luego en producción',
  );
  console.log('\nResumen del gate');
  for (const [item, verdict, note] of gate)
    console.log(
      `  ${verdict === 'sí' ? '✓' : verdict === 'no' ? '✗' : '?'} ${item}: ${verdict}${note ? ` (${note})` : ''}`,
    );
  console.log('');
}

main().catch((error) => {
  bad(failure(error));
  process.exit(1);
});
