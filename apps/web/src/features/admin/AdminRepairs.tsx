import { type RepairOrderView } from '@instafix/contracts';
import { useCallback, useEffect, useState } from 'react';
import { RepairCard } from '../../components/repairs/RepairCard';
import { BusyButton } from '../../components/ui/BusyButton';
import { ListSkeleton } from '../../components/ui/Skeleton';
import { api, ApiError } from '../../lib/api';

type Page = { items: RepairOrderView[]; counts: { shop: number; done: number } };
/** «35,50» o «35.50» → centavos (null si no es un monto válido). */
const toMinor = (value: string) => {
  const n = Number(value.replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
};
const daysSince = (iso: string) => Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);

/**
 * Administración → Taller: los equipos en manos de Instafix. Desde aquí se pone el presupuesto
 * (le llega al cliente por WhatsApp y en Mi cuenta), se registra su respuesta si llegó por otro
 * medio, y se marca listo, entregado o devuelto.
 */
export function AdminRepairs() {
  const [scope, setScope] = useState<'shop' | 'done'>('shop');
  const [q, setQ] = useState('');
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  // Formulario abierto en una tarjeta: presupuesto o entrega.
  const [form, setForm] = useState<{ id: string; kind: 'quote' | 'deliver' | 'return' } | null>(
    null,
  );
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');

  const load = useCallback(() => {
    setError('');
    const params = new URLSearchParams({ scope, ...(q.trim() ? { q: q.trim() } : {}) });
    return api<Page>(`admin/repairs?${params}`)
      .then(setPage)
      .catch((e) => setError(e instanceof ApiError ? e.message : 'No pudimos cargar el taller.'));
  }, [scope, q]);
  useEffect(() => {
    const timer = setTimeout(() => void load(), q ? 300 : 0);
    return () => clearTimeout(timer);
  }, [load, q]);

  async function act(key: string, path: string, body: unknown, done: string) {
    setBusy(key);
    setMessage('');
    try {
      await api(`admin/repairs/${path}`, { method: 'POST', body: JSON.stringify(body) });
      setMessage(done);
      setForm(null);
      await load();
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : 'No se pudo guardar.');
    } finally {
      setBusy(null);
    }
  }
  const open = (id: string, kind: 'quote' | 'deliver' | 'return', initial = '') => {
    setForm({ id, kind });
    setAmount(initial);
    setNote('');
  };

  return (
    <section className="admin-repairs">
      <div className="appt-filters" role="search">
        <div className="filters" role="group" aria-label="Taller">
          <button
            className={scope === 'shop' ? 'active' : ''}
            aria-pressed={scope === 'shop'}
            onClick={() => setScope('shop')}
          >
            En taller <span className="filter-count">{page?.counts.shop ?? '…'}</span>
          </button>
          <button
            className={scope === 'done' ? 'active' : ''}
            aria-pressed={scope === 'done'}
            onClick={() => setScope('done')}
          >
            Entregados <span className="filter-count">{page?.counts.done ?? '…'}</span>
          </button>
        </div>
        <label className="appt-filter-search">
          Buscar
          <input
            type="search"
            value={q}
            placeholder="T-0042, equipo, cliente o teléfono"
            onChange={(e) => setQ(e.target.value)}
          />
        </label>
      </div>
      {message && (
        <p className="admin-message" role="status">
          {message}
        </p>
      )}
      {error && (
        <p role="alert">
          {error} <button onClick={() => void load()}>Reintentar</button>
        </p>
      )}
      {!page && !error && <ListSkeleton label="Cargando el taller…" count={3} />}
      {page && !page.items.length && (
        <p className="tech-empty">
          {scope === 'shop'
            ? 'No hay equipos en el taller. Los registra el técnico desde su visita.'
            : 'Aún no hay equipos entregados.'}
        </p>
      )}
      <div className="repair-list">
        {page?.items.map((o) => {
          const editing = form?.id === o.id ? form.kind : null;
          return (
            <RepairCard key={o.id} order={o} showContact>
              {scope === 'shop' && (
                <p className="small">
                  {daysSince(o.createdAt) === 0
                    ? 'Llegó hoy al taller.'
                    : `Lleva ${daysSince(o.createdAt)} ${daysSince(o.createdAt) === 1 ? 'día' : 'días'} en el taller.`}
                </p>
              )}
              {editing === 'quote' && (
                <form
                  className="repair-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const minor = toMinor(amount);
                    if (minor == null) return setMessage('Escribe un valor válido, p. ej. 35,00.');
                    void act(
                      `${o.id}:quote`,
                      `${o.id}/quote`,
                      { quoteMinor: minor, quoteNote: note },
                      'Presupuesto enviado: el cliente lo ve en su cuenta y, si autorizó WhatsApp, le llega con los botones «Sí, continuar» / «No, devolver».',
                    );
                  }}
                >
                  <label>
                    Presupuesto (USD)
                    <input
                      inputMode="decimal"
                      value={amount}
                      placeholder="35,00"
                      onChange={(e) => setAmount(e.target.value)}
                    />
                  </label>
                  <label>
                    Detalle para el cliente (opcional)
                    <input
                      value={note}
                      maxLength={200}
                      placeholder="Ej.: joystick magnético instalado"
                      onChange={(e) => setNote(e.target.value)}
                    />
                  </label>
                  <div className="tech-actions-row">
                    <button type="button" className="btn btn-ghost" onClick={() => setForm(null)}>
                      Cancelar
                    </button>
                    <BusyButton
                      type="submit"
                      className="btn btn-primary"
                      busy={busy === `${o.id}:quote`}
                      busyLabel="Enviando…"
                    >
                      Enviar presupuesto
                    </BusyButton>
                  </div>
                </form>
              )}
              {(editing === 'deliver' || editing === 'return') && (
                <form
                  className="repair-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const minor = toMinor(amount || '0');
                    if (minor == null) return setMessage('Escribe un valor válido, p. ej. 35,00.');
                    void act(
                      `${o.id}:deliver`,
                      `${o.id}/deliver`,
                      { returned: editing === 'return', finalMinor: minor },
                      editing === 'return' ? 'Equipo devuelto sin reparar.' : 'Equipo entregado.',
                    );
                  }}
                >
                  <label>
                    {editing === 'return'
                      ? 'Cobrado al devolver (USD)'
                      : 'Cobrado al entregar (USD)'}
                    <input
                      inputMode="decimal"
                      value={amount}
                      placeholder="0,00"
                      onChange={(e) => setAmount(e.target.value)}
                    />
                  </label>
                  <div className="tech-actions-row">
                    <button type="button" className="btn btn-ghost" onClick={() => setForm(null)}>
                      Cancelar
                    </button>
                    <BusyButton
                      type="submit"
                      className="btn btn-primary"
                      busy={busy === `${o.id}:deliver`}
                      busyLabel="Guardando…"
                    >
                      {editing === 'return' ? 'Devolver sin reparar' : 'Marcar entregado'}
                    </BusyButton>
                  </div>
                </form>
              )}
              {!editing && scope === 'shop' && (
                <>
                  {o.status === 'RECEIVED' && (
                    <BusyButton
                      type="button"
                      className="btn btn-secondary btn-small"
                      busy={busy === `${o.id}:diag`}
                      busyLabel="Guardando…"
                      onClick={() =>
                        act(
                          `${o.id}:diag`,
                          `${o.id}/status`,
                          { status: 'DIAGNOSING' },
                          'En diagnóstico.',
                        )
                      }
                    >
                      Pasar a diagnóstico
                    </BusyButton>
                  )}
                  {['RECEIVED', 'DIAGNOSING', 'QUOTED'].includes(o.status) && (
                    <button
                      type="button"
                      className="btn btn-primary btn-small"
                      onClick={() =>
                        open(o.id, 'quote', o.quoteMinor != null ? String(o.quoteMinor / 100) : '')
                      }
                    >
                      {o.status === 'QUOTED' ? 'Cambiar presupuesto' : 'Poner presupuesto'}
                    </button>
                  )}
                  {o.status === 'QUOTED' && (
                    <>
                      <BusyButton
                        type="button"
                        className="btn btn-secondary btn-small"
                        busy={busy === `${o.id}:yes`}
                        busyLabel="Guardando…"
                        onClick={() =>
                          act(
                            `${o.id}:yes`,
                            `${o.id}/answer`,
                            { answer: 'APPROVED' },
                            'Registrado: el cliente aprobó el presupuesto.',
                          )
                        }
                      >
                        El cliente aprobó
                      </BusyButton>
                      <BusyButton
                        type="button"
                        className="btn btn-ghost btn-small"
                        busy={busy === `${o.id}:no`}
                        busyLabel="Guardando…"
                        onClick={() =>
                          act(
                            `${o.id}:no`,
                            `${o.id}/answer`,
                            { answer: 'DECLINED' },
                            'Registrado: el cliente no quiere repararlo.',
                          )
                        }
                      >
                        El cliente no quiere
                      </BusyButton>
                    </>
                  )}
                  {o.status === 'APPROVED' && (
                    <BusyButton
                      type="button"
                      className="btn btn-secondary btn-small"
                      busy={busy === `${o.id}:ready`}
                      busyLabel="Guardando…"
                      onClick={() =>
                        act(
                          `${o.id}:ready`,
                          `${o.id}/status`,
                          { status: 'READY' },
                          'Listo para entregar.',
                        )
                      }
                    >
                      Marcar listo
                    </BusyButton>
                  )}
                  {['APPROVED', 'READY'].includes(o.status) && (
                    <button
                      type="button"
                      className="btn btn-primary btn-small"
                      onClick={() =>
                        open(
                          o.id,
                          'deliver',
                          o.quoteMinor != null ? String(o.quoteMinor / 100) : '',
                        )
                      }
                    >
                      Entregar
                    </button>
                  )}
                  {['RECEIVED', 'DIAGNOSING', 'QUOTED', 'DECLINED'].includes(o.status) && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-small"
                      onClick={() => open(o.id, 'return', '0')}
                    >
                      Devolver sin reparar
                    </button>
                  )}
                </>
              )}
            </RepairCard>
          );
        })}
      </div>
    </section>
  );
}
