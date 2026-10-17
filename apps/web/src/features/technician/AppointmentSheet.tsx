import type { Offering, StaffAppointment } from '@instafix/contracts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { StatusPill, visitDay, visitTime } from '../../components/appointments/AppointmentCard';
import { api, ApiError } from '../../lib/api';
import { money } from '../../lib/format';

const CAL_ISSUE = 'Confirmada en Instafix; pendiente de confirmar en Cal.com.';
const plain = (value: string) =>
  value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('es');
const waLink = (phone: string) => `https://wa.me/${phone.replace(/\D/g, '')}`;

/** Detalle de la visita: pantalla completa en el teléfono, panel lateral en escritorio. */
export function AppointmentSheet({
  id,
  catalog,
  onClose,
  onChanged,
}: {
  id: string;
  catalog: Offering[];
  onClose: () => void;
  onChanged: (message?: string) => void;
}) {
  const [item, setItem] = useState<StaffAppointment | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState('');
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');
  const [confirmComplete, setConfirmComplete] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    api<StaffAppointment>(`staff/appointments/${id}`)
      .then((next) => {
        setItem(next);
        setNotes(next.technicianNotes ?? '');
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'No se pudo abrir la cita.'));
  }, [id]);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    heading.current?.focus();
    const key = (event: KeyboardEvent) => event.key === 'Escape' && close.current();
    document.addEventListener('keydown', key);
    document.body.classList.add('sheet-open');
    return () => {
      document.removeEventListener('keydown', key);
      document.body.classList.remove('sheet-open');
    };
  }, []);

  async function act(path: string, init: RequestInit, done?: string) {
    setBusy(true);
    setMessage('');
    try {
      const result = await api<any>(`staff/appointments/${id}${path}`, init);
      const next: StaffAppointment = result.appointment ?? result;
      setItem(next);
      if (path === '/notes') setNotes(next.technicianNotes ?? '');
      if (done) setMessage(done);
      onChanged(done && ['/confirm', '/complete'].includes(path) ? done : undefined);
      return true;
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : 'No se pudo completar la acción.');
      if (e instanceof ApiError && e.status === 409) onChanged();
      return false;
    } finally {
      setBusy(false);
    }
  }

  const options = useMemo(() => {
    const taken = new Set(item?.services.map((s) => s.offeringId));
    const q = plain(query.trim());
    return catalog
      .filter((o) => !taken.has(o.id))
      .filter((o) => !q || plain(`${o.title} ${o.device}`).includes(q))
      .slice(0, 30);
  }, [catalog, item, query]);

  const editable = Boolean(item?.canManage && ['CONFIRMED', 'IN_PROGRESS'].includes(item.status));
  const total = item?.services.reduce((sum, s) => sum + s.totalMinor, 0) ?? 0;
  const notesDirty = notes !== (item?.technicianNotes ?? '');

  return (
    <div className="tech-sheet-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <section className="tech-sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
        <header className="tech-sheet-head">
          <button type="button" className="btn btn-ghost btn-small" onClick={onClose}>
            ← Volver
          </button>
          {item && <StatusPill status={item.status} />}
        </header>
        <h2 id="sheet-title" ref={heading} tabIndex={-1}>
          {item ? `Visita de ${item.contactName || 'cliente'}` : 'Cita'}
        </h2>
        {error && <p role="alert">{error}</p>}
        {!item && !error && <p role="status">Cargando…</p>}
        {item && (
          <>
            {item.automationIssue === CAL_ISSUE && item.canManage && (
              <div className="tech-alert">
                <p>
                  Confirmada en Instafix. Cal.com aún no refleja la confirmación; se reintenta
                  automáticamente.
                </p>
                <button
                  type="button"
                  className="btn btn-ghost btn-small"
                  disabled={busy}
                  onClick={() =>
                    void act('/cal-sync', { method: 'POST' }, 'Sincronización solicitada.')
                  }
                >
                  Reintentar ahora
                </button>
              </div>
            )}
            {item.bookingIdentityIssue && (
              <p className="tech-alert">
                Los datos de contacto de esta cita están en revisión por administración.
              </p>
            )}

            <div className="tech-block tech-when">
              <strong>{visitTime(item.startsAt, item.timeZone)}</strong>
              <span>
                {visitDay(item.startsAt, item.timeZone)} · hasta{' '}
                {visitTime(item.endsAt, item.timeZone)}
              </span>
            </div>

            <div className="tech-block">
              <h3>Solicitud del cliente</h3>
              <p className="tech-request">“{item.request}”</p>
            </div>

            <div className="tech-block">
              <h3>Cliente</h3>
              <p className="tech-strong">{item.contactName || 'Sin nombre'}</p>
              {item.canManage && item.contactPhone ? (
                <div className="tech-actions-row">
                  <a className="btn btn-secondary" href={`tel:${item.contactPhone}`}>
                    Llamar
                  </a>
                  <a
                    className="btn btn-secondary"
                    href={waLink(item.contactPhone)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    WhatsApp
                  </a>
                </div>
              ) : (
                !item.canManage && (
                  <p className="small">El contacto aparece al confirmar la cita.</p>
                )
              )}
              {item.canManage && item.contactPhone && <p className="small">{item.contactPhone}</p>}
              {item.canManage && item.contactEmail && <p className="small">{item.contactEmail}</p>}
            </div>

            <div className="tech-block">
              <h3>Ubicación</h3>
              <p>
                {item.address ||
                  (item.locationReceivedAt
                    ? 'Ubicación recibida por WhatsApp.'
                    : 'Pendiente: el cliente aún no compartió su ubicación por WhatsApp.')}
              </p>
              {item.locationLatitude != null && item.locationLongitude != null && (
                <a
                  className="btn btn-secondary"
                  href={`https://www.google.com/maps/dir/?api=1&destination=${item.locationLatitude},${item.locationLongitude}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Cómo llegar
                </a>
              )}
            </div>

            <div className="tech-block">
              <h3>Técnico asignado</h3>
              <p className="tech-strong">{item.assignedTechnician?.name || 'Sin asignar'}</p>
            </div>

            {item.canManage && (
              <div className="tech-block">
                <h3>Servicios realizados</h3>
                {!item.services.length && (
                  <p className="small">
                    Añade los trabajos que realmente hiciste. La solicitud del cliente se conserva.
                  </p>
                )}
                <ul className="tech-services">
                  {item.services.map((s) => (
                    <li key={s.id}>
                      <div>
                        <strong>{s.nameSnapshot}</strong>
                        <span>
                          {s.deviceSnapshot} · {money(s.unitPriceMinor)} c/u
                        </span>
                      </div>
                      {editable ? (
                        <div className="tech-qty" aria-label={`Cantidad de ${s.nameSnapshot}`}>
                          <button
                            type="button"
                            aria-label="Restar uno"
                            disabled={!editable || busy || s.quantity <= 1}
                            onClick={() =>
                              void act(`/services/${s.id}`, {
                                method: 'PATCH',
                                body: JSON.stringify({ quantity: s.quantity - 1 }),
                              })
                            }
                          >
                            −
                          </button>
                          <output>{s.quantity}</output>
                          <button
                            type="button"
                            aria-label="Sumar uno"
                            disabled={!editable || busy || s.quantity >= 100}
                            onClick={() =>
                              void act(`/services/${s.id}`, {
                                method: 'PATCH',
                                body: JSON.stringify({ quantity: s.quantity + 1 }),
                              })
                            }
                          >
                            +
                          </button>
                        </div>
                      ) : (
                        <span className="tech-qty-fixed">×{s.quantity}</span>
                      )}
                      <span className="tech-subtotal">{money(s.totalMinor)}</span>
                      {editable && (
                        <button
                          type="button"
                          className="tech-remove"
                          aria-label={`Quitar ${s.nameSnapshot}`}
                          disabled={busy}
                          onClick={() => void act(`/services/${s.id}`, { method: 'DELETE' })}
                        >
                          ×
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
                {!!item.services.length && (
                  <p className="tech-total">
                    Total registrado <strong>{money(total)}</strong>
                  </p>
                )}
                {editable &&
                  (adding ? (
                    <div className="tech-picker">
                      <label>
                        Buscar servicio del catálogo
                        <input
                          autoFocus
                          type="search"
                          value={query}
                          placeholder="Ej.: mantenimiento PS5"
                          onChange={(e) => setQuery(e.target.value)}
                        />
                      </label>
                      <ul>
                        {options.map((o) => (
                          <li key={o.id}>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={async () => {
                                const ok = await act('/services', {
                                  method: 'POST',
                                  body: JSON.stringify({ offeringId: o.id, quantity: 1 }),
                                });
                                if (ok) {
                                  setAdding(false);
                                  setQuery('');
                                }
                              }}
                            >
                              <span>
                                <strong>{o.title}</strong>
                                <small>{o.device}</small>
                              </span>
                              <span>{money(o.priceMinor)}</span>
                            </button>
                          </li>
                        ))}
                        {!options.length && (
                          <li className="small">Sin resultados en el catálogo.</li>
                        )}
                      </ul>
                      <button
                        type="button"
                        className="btn btn-ghost btn-block"
                        onClick={() => setAdding(false)}
                      >
                        Cerrar búsqueda
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-secondary btn-block"
                      onClick={() => setAdding(true)}
                    >
                      + {item.services.length ? 'Añadir otro servicio' : 'Añadir servicio'}
                    </button>
                  ))}
              </div>
            )}

            {item.canManage && (
              <div className="tech-block">
                <h3>Notas técnicas</h3>
                <p className="small">Internas: el cliente no las ve.</p>
                <textarea
                  value={notes}
                  maxLength={5000}
                  disabled={!editable || busy}
                  placeholder="Ej.: acumulación severa de polvo y metal líquido desplazado."
                  onChange={(e) => setNotes(e.target.value)}
                />
                {editable && (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={busy || !notesDirty}
                    onClick={() =>
                      void act(
                        '/notes',
                        { method: 'PUT', body: JSON.stringify({ notes }) },
                        'Notas guardadas.',
                      )
                    }
                  >
                    {notesDirty ? 'Guardar notas' : 'Notas guardadas'}
                  </button>
                )}
              </div>
            )}

            {message && (
              <p role="status" className="tech-notice">
                {message}
              </p>
            )}

            <div className="tech-sheet-footer">
              {item.status === 'PENDING_LOCATION' && !item.assignedTechnician && (
                <button
                  type="button"
                  className="btn btn-primary btn-block"
                  disabled={busy}
                  onClick={() =>
                    void act(
                      '/confirm',
                      { method: 'POST' },
                      '✓ Cita confirmada. Ya está en tus citas.',
                    )
                  }
                >
                  {busy ? 'Confirmando…' : 'Confirmar cita'}
                </button>
              )}
              {editable && (
                <button
                  type="button"
                  className="btn btn-success btn-block"
                  disabled={busy || notesDirty}
                  title={notesDirty ? 'Guarda las notas antes de completar' : undefined}
                  onClick={() => setConfirmComplete(true)}
                >
                  Marcar como completada
                </button>
              )}
              {item.status === 'COMPLETED' && <p className="tech-done">✓ Visita completada</p>}
            </div>
          </>
        )}

        {confirmComplete && item && (
          <div
            className="tech-confirm"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="complete-title"
          >
            <div>
              <h3 id="complete-title">¿Marcar la visita como completada?</h3>
              {item.services.length ? (
                <ul className="performed-list">
                  {item.services.map((s) => (
                    <li key={s.id}>
                      {s.nameSnapshot}
                      {s.quantity > 1 ? ` ×${s.quantity}` : ''}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No registraste servicios del catálogo; quedará solo la nota técnica.</p>
              )}
              {!!item.services.length && <p>Total: {money(total)}</p>}
              <p className="small">Después no podrás modificar los servicios ni las notas.</p>
              <div className="tech-actions-row">
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setConfirmComplete(false)}
                >
                  Revisar
                </button>
                <button
                  type="button"
                  className="btn btn-success"
                  disabled={busy}
                  onClick={async () => {
                    await act('/complete', { method: 'POST' }, '✓ Visita completada.');
                    setConfirmComplete(false);
                  }}
                >
                  Sí, completar
                </button>
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
