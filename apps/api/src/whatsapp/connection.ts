import { db } from '../database/client';
import { ProviderError } from '../integrations/provider-error';

export async function connectedWaba() {
  const connection = await db.whatsAppConnection.findUnique({ where: { id: 'main' } });
  const configuredId = process.env.WASAPFLOW_WABA_ID;
  if (
    !connection?.wabaId ||
    connection.connectionMode !== 'coexistence' ||
    !connection.connectedAt ||
    (configuredId && configuredId !== connection.wabaId)
  )
    return null;
  return connection.wabaId;
}
export async function requireConnectedWaba() {
  const id = await connectedWaba();
  if (!id) throw new ProviderError('Completa la conexión WasapFlow en modo Coexistence', 'FAILED');
  return id;
}
