import { repairInShop, type RepairOrderView } from '@instafix/contracts';
import { useCallback, useEffect, useState } from 'react';
import { RepairCard } from '../../components/repairs/RepairCard';
import { BusyButton } from '../../components/ui/BusyButton';
import { ListSkeleton } from '../../components/ui/Skeleton';
import { api, ApiError } from '../../lib/api';
import { money } from '../../lib/format';

/**
 * Mi cuenta → En taller: los equipos que el cliente nos entregó en una visita, su estado y el
 * presupuesto, que puede aprobar o rechazar aquí (entonces ya no le llega el WhatsApp).
 */
export function CustomerRepairs() {
  const [orders, setOrders] = useState<RepairOrderView[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState('');

  const load = useCallback(() => {
    setError('');
    return api<RepairOrderView[]>('my/repairs')
      .then(setOrders)
      .catch((e) => setError(e instanceof ApiError ? e.message : 'No pudimos cargar tus equipos.'));
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function answer(order: RepairOrderView, value: 'APPROVED' | 'DECLINED') {
    setBusy(`${order.id}:${value}`);
    setNotice('');
    try {
      await api(`my/repairs/${order.id}/answer`, {
        method: 'POST',
        body: JSON.stringify({ answer: value }),
      });
      setNotice(
        value === 'APPROVED'
          ? `Listo: continuamos con la reparación de tu ${order.device}.`
          : `Entendido: te devolveremos tu ${order.device} sin reparar.`,
      );
      await load();
    } catch (e) {
      setNotice(e instanceof ApiError ? e.message : 'No pudimos guardar tu respuesta.');
      await load();
    } finally {
      setBusy(null);
    }
  }

  if (error)
    return (
      <p role="alert">
        {error} <button onClick={() => void load()}>Reintentar</button>
      </p>
    );
  if (!orders) return <ListSkeleton label="Cargando tus equipos…" count={2} />;
  const inShop = orders.filter((o) => repairInShop(o.status));
  const done = orders.filter((o) => !repairInShop(o.status));
  if (!orders.length)
    return (
      <div className="empty-account">
        <h2>No tienes equipos en el taller</h2>
        <p>
          Si en una visita nuestro técnico se lleva un equipo para repararlo, aquí verás en qué
          estado está y su presupuesto.
        </p>
      </div>
    );
  return (
    <div className="customer-repairs">
      {notice && (
        <p className="admin-message" role="status">
          {notice}
        </p>
      )}
      <h2 className="repair-section-title">En taller</h2>
      {!inShop.length && <p className="small">Ahora no tenemos ningún equipo tuyo.</p>}
      <div className="repair-list">
        {inShop.map((order) => (
          <RepairCard key={order.id} order={order}>
            {order.status === 'QUOTED' && order.quoteMinor != null && (
              <div className="repair-form">
                <p>
                  El presupuesto para tu {order.device} es{' '}
                  <strong>{money(order.quoteMinor)}</strong>. ¿Continuamos con la reparación?
                </p>
                <div className="tech-actions-row">
                  <BusyButton
                    type="button"
                    className="btn btn-primary"
                    disabled={!!busy}
                    busy={busy === `${order.id}:APPROVED`}
                    busyLabel="Guardando…"
                    onClick={() => answer(order, 'APPROVED')}
                  >
                    Sí, continuar
                  </BusyButton>
                  <BusyButton
                    type="button"
                    className="btn btn-ghost"
                    disabled={!!busy}
                    busy={busy === `${order.id}:DECLINED`}
                    busyLabel="Guardando…"
                    onClick={() => answer(order, 'DECLINED')}
                  >
                    No, devolver
                  </BusyButton>
                </div>
              </div>
            )}
          </RepairCard>
        ))}
      </div>
      {!!done.length && (
        <>
          <h2 className="repair-section-title">Entregados</h2>
          <div className="repair-list">
            {done.map((order) => (
              <RepairCard key={order.id} order={order} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
