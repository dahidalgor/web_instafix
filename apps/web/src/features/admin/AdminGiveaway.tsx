import {
  entriesLabel,
  type Giveaway,
  type GiveawayInput,
  type Offering,
} from '@instafix/contracts';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
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
  otherGiveaway: boolean;
  contactName: string;
  contactPhone: string;
};
type Summary = Giveaway & { open: boolean; totalEntries: number; participants: number };
type Participant = { key: string; name: string; phone: string; entries: number; visits: Visit[] };
type Detail = Summary & { people: Participant[] };

const day = (value: string) =>
  new Intl.DateTimeFormat('es-EC', { dateStyle: 'medium', timeZone: 'America/Guayaquil' }).format(
    new Date(value),
  );
const drawDay = (value: string) =>
  new Intl.DateTimeFormat('es-EC', { dateStyle: 'long', timeZone: 'UTC' }).format(
    new Date(`${value}T12:00:00Z`),
  );
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Guayaquil' }).format();
const errorText = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

/**
 * Administración → Sorteos: crear un sorteo, cerrarlo, ver participantes (y descargarlos) y
 * corregir las participaciones de una visita. Solo puede haber uno abierto a la vez.
 */
export function AdminGiveaway() {
  const [list, setList] = useState<Summary[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const loadList = useCallback(
    () =>
      api<Summary[]>('admin/giveaways')
        .then((items) => {
          setList(items);
          setSelected((current) => current ?? items[0]?.id ?? null);
        })
        .catch((e) => setError(errorText(e, 'No se pudieron cargar los sorteos.'))),
    [],
  );
  const loadDetail = useCallback(
    (id: string) =>
      api<Detail>(`admin/giveaways/${id}`)
        .then(setDetail)
        .catch((e) => setError(errorText(e, 'No se pudo cargar el sorteo.'))),
    [],
  );
  useEffect(() => {
    void loadList();
  }, [loadList]);
  useEffect(() => {
    setDetail(null);
    if (selected) void loadDetail(selected);
  }, [selected, loadDetail]);

  const hasOpen = Boolean(list?.some((g) => g.open));

  async function close(giveaway: Summary) {
    if (
      !window.confirm(
        `¿Cerrar el sorteo de ${giveaway.prize}? Ya no se podrán sumar ni corregir participaciones. Las registradas se conservan.`,
      )
    )
      return;
    setError('');
    setNotice('');
    try {
      setDetail(await api<Detail>(`admin/giveaways/${giveaway.id}/close`, { method: 'POST' }));
      setNotice(`Sorteo de ${giveaway.prize} cerrado.`);
      await loadList();
    } catch (e) {
      setError(errorText(e, 'No se pudo cerrar el sorteo.'));
    }
  }

  return (
    <section className="giveaway-admin">
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
      {!list && !error && <ListSkeleton label="Cargando sorteos…" count={3} />}

      {list && (
        <div className="giveaway-toolbar">
          {list.length > 0 && (
            <label>
              Sorteo
              <select value={selected ?? ''} onChange={(e) => setSelected(e.target.value)}>
                {list.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.prize} · {drawDay(g.drawDate)} · {g.open ? 'Abierto' : 'Cerrado'}
                  </option>
                ))}
              </select>
            </label>
          )}
          {!creating && (
            <button
              type="button"
              className="btn btn-secondary"
              disabled={hasOpen}
              title={hasOpen ? 'Cierra el sorteo abierto antes de crear otro.' : undefined}
              onClick={() => setCreating(true)}
            >
              Nuevo sorteo
            </button>
          )}
        </div>
      )}
      {list && hasOpen && !creating && (
        <p className="small">Para crear otro sorteo, primero cierra el que está abierto.</p>
      )}
      {list && !list.length && !creating && (
        <p className="tech-empty">Todavía no hay sorteos. Crea el primero con «Nuevo sorteo».</p>
      )}

      {creating && (
        <NewGiveaway
          onCancel={() => setCreating(false)}
          onCreated={async (created) => {
            setCreating(false);
            setNotice(`Sorteo de ${created.prize} creado y abierto.`);
            setSelected(created.id);
            await loadList();
          }}
          onError={setError}
        />
      )}

      {selected && !detail && !error && <ListSkeleton label="Cargando participantes…" count={2} />}
      {detail && !creating && (
        <GiveawayDetail
          detail={detail}
          onClose={() => close(detail)}
          onChanged={(message) => {
            setNotice(message);
            void loadDetail(detail.id);
            void loadList();
          }}
          onError={setError}
        />
      )}
    </section>
  );
}

function NewGiveaway({
  onCancel,
  onCreated,
  onError,
}: {
  onCancel: () => void;
  onCreated: (giveaway: Summary) => void;
  onError: (message: string) => void;
}) {
  const [catalog, setCatalog] = useState<Offering[]>([]);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<GiveawayInput>({
    prize: '',
    drawDate: '',
    entryRule: '',
    maxEntries: 20,
    eligibleOfferingIds: [],
  });
  useEffect(() => {
    api<Offering[]>('admin/services')
      .then(setCatalog)
      .catch(() => setCatalog([]));
  }, []);
  const toggle = (id: string) =>
    setForm({
      ...form,
      eligibleOfferingIds: form.eligibleOfferingIds.includes(id)
        ? form.eligibleOfferingIds.filter((value) => value !== id)
        : [...form.eligibleOfferingIds, id],
    });

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    onError('');
    try {
      onCreated(
        await api<Summary>('admin/giveaways', { method: 'POST', body: JSON.stringify(form) }),
      );
    } catch (e) {
      onError(errorText(e, 'No se pudo crear el sorteo.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="giveaway-form" onSubmit={submit}>
      <h3>Nuevo sorteo</h3>
      <label>
        Premio
        <input
          required
          minLength={2}
          maxLength={80}
          placeholder="Ej.: PlayStation 5"
          value={form.prize}
          onChange={(e) => setForm({ ...form, prize: e.target.value })}
        />
      </label>
      <label>
        Día del sorteo (se aceptan participaciones hasta el final de ese día)
        <input
          type="date"
          required
          min={today()}
          value={form.drawDate}
          onChange={(e) => setForm({ ...form, drawDate: e.target.value })}
        />
      </label>
      <label>
        Cómo se participa (lo ven técnicos y clientes)
        <textarea
          required
          minLength={10}
          maxLength={300}
          rows={2}
          placeholder="Ej.: Una participación por cada mando con par de joysticks magnéticos."
          value={form.entryRule}
          onChange={(e) => setForm({ ...form, entryRule: e.target.value })}
        />
      </label>
      <label>
        Máximo de participaciones por visita
        <input
          type="number"
          min={1}
          max={100}
          required
          value={form.maxEntries}
          onChange={(e) => setForm({ ...form, maxEntries: Number(e.target.value) })}
        />
      </label>
      <fieldset className="giveaway-offerings">
        <legend>Servicios que suman (opcional)</legend>
        <p className="small">
          Al registrar uno de estos servicios, el panel técnico marca la participación sola (una por
          unidad). El técnico siempre puede ajustarla.
        </p>
        {catalog.map((offering) => (
          <label key={offering.id} className="checkbox-label">
            <input
              type="checkbox"
              checked={form.eligibleOfferingIds.includes(offering.id)}
              onChange={() => toggle(offering.id)}
            />
            {offering.title} · {offering.device}
          </label>
        ))}
      </fieldset>
      <div className="giveaway-form-actions">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancelar
        </button>
        <BusyButton type="submit" className="btn btn-primary" busy={busy} busyLabel="Creando…">
          Crear y abrir sorteo
        </BusyButton>
      </div>
    </form>
  );
}

function GiveawayDetail({
  detail,
  onClose,
  onChanged,
  onError,
}: {
  detail: Detail;
  onClose: () => void;
  onChanged: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Visit[] | null>(null);
  // Búsqueda de visitas completadas para corregir (también las que no participan).
  useEffect(() => {
    const text = query.trim();
    if (text.length < 2) {
      setResults(null);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      api<Visit[]>(`admin/giveaways/${detail.id}/visits?q=${encodeURIComponent(text)}`, {
        signal: controller.signal,
      })
        .then(setResults)
        .catch((e) => !controller.signal.aborted && onError(errorText(e, 'Sin resultados.')));
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, detail.id, onError]);

  async function save(visit: Visit, entries: number) {
    onError('');
    try {
      const updated = await api<Visit>(`admin/giveaways/${detail.id}/visits/${visit.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ giveawayEntries: entries }),
      });
      setResults((list) => list?.map((v) => (v.id === updated.id ? updated : v)) ?? null);
      onChanged(`${updated.contactName}: ${entriesLabel(updated.giveawayEntries)} guardadas.`);
      return true;
    } catch (e) {
      onError(errorText(e, 'No se pudo guardar.'));
      return false;
    }
  }

  function downloadCsv() {
    const cell = (value: string | number) => `"${String(value).replace(/"/g, '""')}"`;
    const rows = [
      ['Nombre', 'Teléfono', 'Participaciones', 'Visitas'],
      ...detail.people.map((p) => [p.name, p.phone, p.entries, p.visits.length]),
    ];
    const csv = '﻿' + rows.map((row) => row.map(cell).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `sorteo-${detail.prize.replace(/\s+/g, '-').toLowerCase()}-${detail.drawDate}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <div className="giveaway-summary">
        <span className={`giveaway-state ${detail.open ? 'is-open' : ''}`}>
          {detail.open ? 'Abierto' : 'Cerrado'}
        </span>
        <p>
          Premio: <strong>{detail.prize}</strong> · sorteo el{' '}
          <strong>{drawDay(detail.drawDate)}</strong>.{' '}
          {detail.participants === 1 ? '1 participante' : `${detail.participants} participantes`} ·{' '}
          <strong>{entriesLabel(detail.totalEntries)}</strong>
        </p>
        <p className="small">{detail.entryRule}</p>
        <div className="giveaway-summary-actions">
          {detail.people.length > 0 && (
            <button type="button" className="btn btn-secondary btn-small" onClick={downloadCsv}>
              Descargar lista (CSV)
            </button>
          )}
          {detail.open && (
            <button type="button" className="btn btn-danger btn-small" onClick={onClose}>
              Cerrar sorteo
            </button>
          )}
        </div>
      </div>

      <h3>Participantes</h3>
      {!detail.people.length && (
        <p className="tech-empty">Todavía no hay participaciones registradas.</p>
      )}
      <ol className="giveaway-list">
        {detail.people.map((p) => (
          <li key={p.key} className="giveaway-person">
            <div className="giveaway-person-head">
              <div>
                <strong>{p.name}</strong>
                <span>{p.phone}</span>
              </div>
              <span className="giveaway-badge">{entriesLabel(p.entries)}</span>
            </div>
            <ul className="giveaway-visits">
              {p.visits.map((v) => (
                <VisitRow
                  key={`${v.id}:${v.giveawayEntries}`}
                  visit={v}
                  open={detail.open}
                  max={detail.maxEntries}
                  onSave={save}
                />
              ))}
            </ul>
          </li>
        ))}
      </ol>

      {detail.open && (
        <>
          <h3>Corregir una visita</h3>
          <p className="small">
            Si un técnico olvidó marcar la participación o puso otro número, busca la visita
            completada por nombre o teléfono del cliente.
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
                  open={detail.open && !v.otherGiveaway}
                  max={detail.maxEntries}
                  onSave={save}
                  showCustomer
                />
              ))}
            </ul>
          )}
        </>
      )}
    </>
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
          {visit.otherGiveaway ? ' · participa en otro sorteo' : ''}
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
