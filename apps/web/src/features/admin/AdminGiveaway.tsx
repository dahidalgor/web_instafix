import { useEffect, useState } from 'react';
import { BusyButton } from '../../components/ui/BusyButton';
import { ListSkeleton } from '../../components/ui/Skeleton';
import { api } from '../../lib/api';

type Visit = {
  id: string;
  completedAt: string | null;
  title: string;
  services: string[];
  technician: string | null;
  giveawayEntries: number;
  contactName: string;
  contactPhone: string;
};
type Participant = { key: string; name: string; phone: string; entries: number; visits: Visit[] };
type Summary = {
  prize: string;
  drawDate: string;
  open: boolean;
  maxEntries: number;
  totalEntries: number;
  participants: Participant[];
};

const day = (value: string) =>
  new Intl.DateTimeFormat('es-EC', { dateStyle: 'medium', timeZone: 'America/Guayaquil' }).format(
    new Date(value),
  );
const drawDay = (value: string) =>
  new Intl.DateTimeFormat('es-EC', { dateStyle: 'long', timeZone: 'UTC' }).format(
    new Date(`${value}T12:00:00Z`),
  );
const plural = (n: number) => (n === 1 ? '1 participación' : `${n} participaciones`);

/** Administración → Sorteo: participantes y corrección de participaciones por visita. */
export function AdminGiveaway() {
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Visit[] | null>(null);

  const load = () =>
    api<Summary>('admin/giveaway')
      .then(setData)
      .catch((e) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);
  // Búsqueda de visitas completadas para corregir (también las que no participan).
  useEffect(() => {
    const text = query.trim();
    if (text.length < 2) {
      setResults(null);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      api<Visit[]>(`admin/giveaway/visits?q=${encodeURIComponent(text)}`, {
        signal: controller.signal,
      })
        .then(setResults)
        .catch((e) => !controller.signal.aborted && setError(e.message));
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  async function save(visit: Visit, entries: number) {
    setError('');
    setNotice('');
    try {
      const updated = await api<Visit>(`admin/giveaway/visits/${visit.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ giveawayEntries: entries }),
      });
      setNotice(`${updated.contactName}: ${plural(updated.giveawayEntries)} guardadas.`);
      setResults((list) => list?.map((v) => (v.id === updated.id ? updated : v)) ?? null);
      await load();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo guardar.');
      return false;
    }
  }

  function downloadCsv() {
    if (!data) return;
    const cell = (value: string | number) => `"${String(value).replace(/"/g, '""')}"`;
    const rows = [
      ['Nombre', 'Teléfono', 'Participaciones', 'Visitas'],
      ...data.participants.map((p) => [p.name, p.phone, p.entries, p.visits.length]),
    ];
    const csv = '﻿' + rows.map((row) => row.map(cell).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `sorteo-${data.prize.replace(/\s+/g, '-').toLowerCase()}-${data.drawDate}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="giveaway-admin">
      {!data && !error && <ListSkeleton label="Cargando sorteo…" count={3} />}
      {data && (
        <div className="giveaway-summary">
          <span className={`giveaway-state ${data.open ? 'is-open' : ''}`}>
            {data.open ? 'Abierto' : 'Cerrado'}
          </span>
          <p>
            Premio: <strong>{data.prize}</strong> · sorteo el{' '}
            <strong>{drawDay(data.drawDate)}</strong>.{' '}
            {data.participants.length === 1
              ? '1 participante'
              : `${data.participants.length} participantes`}{' '}
            · <strong>{plural(data.totalEntries)}</strong>
          </p>
          {data.participants.length > 0 && (
            <button type="button" className="btn btn-secondary btn-small" onClick={downloadCsv}>
              Descargar lista (CSV)
            </button>
          )}
        </div>
      )}
      {error && (
        <p className="admin-message" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="admin-message" role="status">
          {notice}
        </p>
      )}

      {data && (
        <>
          <h3>Participantes</h3>
          {!data.participants.length && (
            <p className="tech-empty">Todavía no hay participaciones registradas.</p>
          )}
          <ol className="giveaway-list">
            {data.participants.map((p) => (
              <li key={p.key} className="giveaway-person">
                <div className="giveaway-person-head">
                  <div>
                    <strong>{p.name}</strong>
                    <span>{p.phone}</span>
                  </div>
                  <span className="giveaway-badge">{plural(p.entries)}</span>
                </div>
                <ul className="giveaway-visits">
                  {p.visits.map((v) => (
                    <VisitRow
                      key={`${v.id}:${v.giveawayEntries}`}
                      visit={v}
                      open={data.open}
                      max={data.maxEntries}
                      onSave={save}
                    />
                  ))}
                </ul>
              </li>
            ))}
          </ol>

          <h3>Corregir una visita</h3>
          <p className="small">
            Si un técnico olvidó marcar la participación o puso otro número, busca la visita
            completada por nombre o teléfono del cliente.
            {!data.open && ' El sorteo ya cerró: las participaciones no se pueden cambiar.'}
          </p>
          <label className="admin-search">
            Buscar visita completada
            <input
              type="search"
              value={query}
              maxLength={100}
              placeholder="Ej.: Paul, 0991234567"
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          {results && !results.length && (
            <p className="tech-empty">No hay visitas completadas con esa búsqueda.</p>
          )}
          {results && results.length > 0 && (
            <ul className="giveaway-visits is-search">
              {results.map((v) => (
                <VisitRow
                  key={`${v.id}:${v.giveawayEntries}`}
                  visit={v}
                  open={data.open}
                  max={data.maxEntries}
                  onSave={save}
                  showCustomer
                />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function VisitRow({
  visit,
  open,
  max,
  onSave,
  showCustomer,
}: {
  visit: Visit;
  open: boolean;
  max: number;
  onSave: (visit: Visit, entries: number) => Promise<boolean>;
  showCustomer?: boolean;
}) {
  const [entries, setEntries] = useState(visit.giveawayEntries);
  const [busy, setBusy] = useState(false);
  const changed = entries !== visit.giveawayEntries;
  return (
    <li className="giveaway-visit">
      <div>
        {showCustomer && (
          <strong>
            {visit.contactName} · {visit.contactPhone}
          </strong>
        )}
        <span>
          {visit.completedAt ? day(visit.completedAt) : 'Completada'}
          {visit.technician ? ` · ${visit.technician}` : ''}
        </span>
        <small>{visit.services.length ? visit.services.join(' + ') : visit.title}</small>
      </div>
      {open ? (
        <div className="giveaway-edit">
          <div className="tech-qty" role="group" aria-label="Participaciones de la visita">
            <button
              type="button"
              aria-label="Una participación menos"
              disabled={busy || entries <= 0}
              onClick={() => setEntries((n) => Math.max(0, n - 1))}
            >
              −
            </button>
            <output aria-live="polite">{entries}</output>
            <button
              type="button"
              aria-label="Una participación más"
              disabled={busy || entries >= max}
              onClick={() => setEntries((n) => Math.min(max, n + 1))}
            >
              +
            </button>
          </div>
          {changed && (
            <BusyButton
              type="button"
              className="btn btn-primary btn-small"
              busy={busy}
              busyLabel="Guardando…"
              onClick={async () => {
                setBusy(true);
                const ok = await onSave(visit, entries);
                setBusy(false);
                if (!ok) setEntries(visit.giveawayEntries);
              }}
            >
              Guardar
            </BusyButton>
          )}
        </div>
      ) : (
        <span className="giveaway-badge">{visit.giveawayEntries}</span>
      )}
    </li>
  );
}
