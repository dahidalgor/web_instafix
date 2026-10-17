import { db } from '../database/client';
import { ProviderError } from '../integrations/provider-error';
import type { WasapFlowClient } from './wasapflow.client';

const configuredId = () => process.env.WASAPFLOW_WABA_ID?.trim() || null;
/** Un WABA ID es numérico. Otro valor (p. ej. la Partner Key pegada por error) nunca se repite. */
export const validWabaId = (value: string | null) => !value || /^\d{5,25}$/.test(value);

/** WABA con la que opera Instafix, ya verificada y guardada en PostgreSQL. */
export async function connectedWaba() {
  const connection = await db.whatsAppConnection.findUnique({ where: { id: 'main' } });
  const configured = configuredId();
  if (
    !connection?.wabaId ||
    !connection.connectedAt ||
    (configured && configured !== connection.wabaId)
  )
    return null;
  return connection.wabaId;
}

/**
 * Si la WABA se registró directamente en WasapFlow (panel o /clients/register) y no con el
 * botón de Administración, Instafix no tenía conexión guardada y no enviaba nada. Con
 * WASAPFLOW_WABA_ID configurado, se comprueba en WasapFlow que pertenece a este partner y está
 * activa, y entonces se adopta. Nunca adopta una WABA que WasapFlow no confirme.
 */
export async function adoptConfiguredWaba(bridge: WasapFlowClient) {
  const wabaId = configuredId();
  if (!validWabaId(wabaId))
    throw new ProviderError(
      'WASAPFLOW_WABA_ID no es un ID de WABA (debe ser solo números). Revisa que no contenga la Partner Key.',
      'FAILED',
    );
  if (!wabaId)
    throw new ProviderError(
      'No hay WABA conectada: configura WASAPFLOW_WABA_ID o conecta desde Administración → WhatsApp',
      'FAILED',
    );
  const clients = await bridge.listClients();
  const client = clients.find((item) => item.waba_id === wabaId);
  if (!client)
    throw new ProviderError(
      `WASAPFLOW_WABA_ID ${wabaId} no está registrada en esta cuenta de WasapFlow (hay ${clients.length})`,
      'FAILED',
    );
  if (client.status !== 'active')
    throw new ProviderError(
      `La WABA ${wabaId} está en estado «${client.status}» en WasapFlow`,
      'FAILED',
    );
  await db.whatsAppConnection.upsert({
    where: { id: 'main' },
    create: {
      id: 'main',
      wabaId,
      connectionMode: client.connection_mode || 'unknown',
      connectedAt: new Date(),
    },
    update: {
      wabaId,
      connectionMode: client.connection_mode || 'unknown',
      connectedAt: new Date(),
    },
  });
  return wabaId;
}

export async function requireConnectedWaba(bridge?: WasapFlowClient) {
  const id = await connectedWaba();
  if (id) return id;
  if (bridge) return adoptConfiguredWaba(bridge);
  throw new ProviderError(
    'No hay WABA conectada: configura WASAPFLOW_WABA_ID o conecta desde Administración → WhatsApp',
    'FAILED',
  );
}
