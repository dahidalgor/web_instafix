import { BusyButton } from '../../components/ui/BusyButton';
import { ListSkeleton } from '../../components/ui/Skeleton';
import type { CatalogEquipment, Offering, ServiceCategory } from '@instafix/contracts';
import { useState, type Dispatch, type FormEvent, type SetStateAction } from 'react';
import { money } from '../../lib/format';
import { availabilityLabels } from '../catalog/catalog.constants';
import { MediaEditor } from '../media/MediaEditor';
import { CoverEditor } from '../media/CoverEditor';
import { mediaProblem, serviceCover } from '@instafix/contracts';
import { emptyService, type ServiceDraft } from './admin.types';
type Props = {
  items: Offering[];
  equipment: CatalogEquipment[];
  categories: ServiceCategory[];
  draft: ServiceDraft;
  setDraft: Dispatch<SetStateAction<ServiceDraft>>;
  update: <K extends keyof ServiceDraft>(key: K, value: ServiceDraft[K]) => void;
  uploading: boolean;
  setUploading: (value: boolean) => void;
  save: (event: FormEvent) => Promise<void>;
  busy: boolean;
  loading?: boolean;
  remove: (id: string) => Promise<boolean>;
};
type Sort = 'name' | 'price-asc' | 'price-desc';
/** Comparación sin mayúsculas ni tildes: «bateria» encuentra «Batería». */
const fold = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
export function AdminServices({
  items,
  equipment,
  categories,
  draft,
  setDraft,
  update,
  uploading,
  setUploading,
  save,
  busy,
  loading,
  remove,
}: Props) {
  const [name, setName] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [equipmentId, setEquipmentId] = useState('');
  const [sort, setSort] = useState<Sort>('name');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const categoryOf = (item: Offering) =>
    equipment.find((device) => device.id === item.equipmentId)?.categoryId;
  const devicesInCategory = equipment.filter(
    (device) => !categoryId || device.categoryId === categoryId,
  );
  const words = fold(name.trim());
  const visible = items
    .filter((item) => !categoryId || categoryOf(item) === categoryId)
    .filter((item) => !equipmentId || item.equipmentId === equipmentId)
    .filter((item) => !words || fold(item.title).includes(words))
    .sort((a, b) =>
      sort === 'price-asc'
        ? a.priceMinor - b.priceMinor
        : sort === 'price-desc'
          ? b.priceMinor - a.priceMinor
          : `${a.device} ${a.title}`.localeCompare(`${b.device} ${b.title}`, 'es'),
    );
  const filtered = Boolean(categoryId || equipmentId || words);
  const clearFilters = () => {
    setName('');
    setCategoryId('');
    setEquipmentId('');
  };
  const pick = (next: ServiceDraft) => {
    setConfirmDelete(false);
    setDraft(next);
  };
  async function onDelete() {
    if (!draft.id) return;
    setDeleting(true);
    const ok = await remove(draft.id);
    setDeleting(false);
    if (ok) setConfirmDelete(false);
  }
  const inactiveDevice = (id: string | null | undefined) =>
    equipment.find((device) => device.id === id)?.active === false;
  return (
    <div className="admin-layout">
      <section>
        <h2>Catálogo</h2>
        <button
          className="btn btn-primary"
          disabled={uploading}
          onClick={() => pick({ ...emptyService })}
        >
          + Nuevo servicio
        </button>
        <div className="service-filters" role="search" aria-label="Filtrar servicios">
          <label className="is-wide">
            Buscar por nombre
            <input
              type="search"
              value={name}
              maxLength={100}
              placeholder="Ej.: Mantenimiento"
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            Categoría
            <select
              value={categoryId}
              onChange={(e) => {
                setCategoryId(e.target.value);
                setEquipmentId('');
              }}
            >
              <option value="">Todas</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Equipo
            <select value={equipmentId} onChange={(e) => setEquipmentId(e.target.value)}>
              <option value="">Todos</option>
              {devicesInCategory.map((device) => (
                <option key={device.id} value={device.id}>
                  {device.name}
                  {device.active === false ? ' (desactivado)' : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="is-wide">
            Ordenar por
            <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
              <option value="name">Equipo y nombre</option>
              <option value="price-asc">Precio: de menor a mayor</option>
              <option value="price-desc">Precio: de mayor a menor</option>
            </select>
          </label>
        </div>
        {!loading && items.length > 0 && (
          <p className="small" role="status">
            {visible.length === 1 ? '1 servicio' : `${visible.length} servicios`}
            {filtered && ` de ${items.length} · `}
            {filtered && (
              <button type="button" className="link-button" onClick={clearFilters}>
                Quitar filtros
              </button>
            )}
          </p>
        )}
        {loading && <ListSkeleton label="Cargando catálogo…" count={4} />}
        {!loading && !items.length && <p className="tech-empty">Aún no hay servicios.</p>}
        {!loading && items.length > 0 && !visible.length && (
          <p className="tech-empty">Ningún servicio coincide con los filtros.</p>
        )}
        {visible.map((item) => (
          <button
            className="admin-item admin-service-item"
            disabled={uploading}
            key={item.id}
            onClick={() =>
              pick({
                id: item.id,
                title: item.title,
                equipmentId: item.equipmentId ?? '',
                description: item.description,
                priceMinor: item.priceMinor,
                durationMinutes: item.durationMinutes,
                warrantyDays: item.warrantyDays,
                availability: item.availability,
                media: item.media,
                cover: item.cover ?? null,
              })
            }
          >
            {serviceCover(item) && (
              <img
                src={serviceCover(item)!.thumbnail || serviceCover(item)!.url}
                alt=""
                loading="lazy"
              />
            )}
            <strong>
              {item.device} · {item.title}
            </strong>
            <span>
              {money(item.priceMinor)} · {availabilityLabels[item.availability]}
              {inactiveDevice(item.equipmentId) && (
                <em className="is-off"> · Equipo desactivado: no se publica</em>
              )}
            </span>
          </button>
        ))}
      </section>
      <form className="editor" onSubmit={save}>
        <h2>{draft.id ? 'Editar servicio' : 'Nuevo servicio'}</h2>
        <label>
          Categoría y equipo
          <select
            required
            value={draft.equipmentId}
            onChange={(e) => update('equipmentId', e.target.value)}
          >
            <option value="">Selecciona equipo</option>
            {/* Agrupado por categoría: Categoría → Equipo → Servicio. */}
            {categories.map((category) => {
              const devices = equipment.filter((item) => item.categoryId === category.id);
              return devices.length ? (
                <optgroup key={category.id} label={category.name}>
                  {devices.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                      {item.active === false ? ' (desactivado)' : ''}
                    </option>
                  ))}
                </optgroup>
              ) : null;
            })}
          </select>
        </label>
        <label>
          Nombre
          <input
            required
            minLength={3}
            maxLength={150}
            value={draft.title}
            onChange={(e) => update('title', e.target.value)}
          />
        </label>
        <label>
          Descripción
          <textarea
            required
            minLength={10}
            maxLength={5000}
            value={draft.description}
            onChange={(e) => update('description', e.target.value)}
          />
        </label>
        <div className="form-row">
          <label>
            Precio USD
            <input
              type="number"
              min="0"
              max="100000"
              step="0.01"
              required
              value={draft.priceMinor / 100}
              onChange={(e) => update('priceMinor', Math.round(Number(e.target.value) * 100))}
            />
          </label>
          <label>
            Disponibilidad
            <select
              value={draft.availability}
              onChange={(e) =>
                update('availability', e.target.value as ServiceDraft['availability'])
              }
            >
              {Object.entries(availabilityLabels).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="form-row">
          <label>
            Duración (minutos)
            <input
              type="number"
              min="1"
              max="1440"
              required
              value={draft.durationMinutes}
              onChange={(e) => update('durationMinutes', Number(e.target.value))}
            />
          </label>
          <label>
            Garantía anunciada (días)
            <input
              type="number"
              min="0"
              max="3650"
              required
              value={draft.warrantyDays}
              onChange={(e) => update('warrantyDays', Number(e.target.value))}
            />
          </label>
        </div>
        <CoverEditor
          key={`cover-${draft.id || 'new'}`}
          value={draft.cover}
          fallback={
            draft.cover ? null : (serviceCover({ cover: null, media: draft.media })?.url ?? null)
          }
          onChange={(cover) => update('cover', cover)}
          onBusy={setUploading}
        />
        <MediaEditor
          key={draft.id || 'new'}
          value={draft.media}
          onChange={(media) => update('media', media)}
          onBusy={setUploading}
        />
        <BusyButton
          type="submit"
          className="button"
          disabled={uploading || !!mediaProblem(draft.media)}
          busy={busy}
          busyLabel="Guardando…"
        >
          Guardar servicio
        </BusyButton>
        {draft.id && !confirmDelete && (
          <button
            type="button"
            className="btn btn-danger service-delete"
            disabled={busy || uploading || deleting}
            onClick={() => setConfirmDelete(true)}
          >
            Eliminar servicio
          </button>
        )}
        {draft.id && confirmDelete && (
          <div
            className="security-panel service-delete"
            role="alertdialog"
            aria-labelledby="delete-service-title"
          >
            <p id="delete-service-title">
              <strong>¿Eliminar «{draft.title}»?</strong> Deja de aparecer en el catálogo y ya no se
              puede reservar ni añadir a una visita. Las citas y trabajos anteriores conservan su
              nombre y precio.
            </p>
            <div className="confirm-actions">
              <button
                type="button"
                className="btn btn-ghost"
                disabled={deleting}
                onClick={() => setConfirmDelete(false)}
              >
                Mantener
              </button>
              <BusyButton
                type="button"
                className="btn btn-danger"
                busy={deleting}
                busyLabel="Eliminando…"
                onClick={() => void onDelete()}
              >
                Sí, eliminar
              </BusyButton>
            </div>
          </div>
        )}
      </form>
    </div>
  );
}
