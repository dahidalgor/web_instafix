import { NumberField } from '../../components/ui/NumberField';
import { SortableList } from '../../components/ui/SortableList';
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
  /** Guarda el nuevo orden de los servicios de un equipo. */
  reorder: (equipmentId: string, ids: string[]) => Promise<void>;
};
type Sort = 'manual' | 'name' | 'price-asc' | 'price-desc';
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
  reorder,
}: Props) {
  const [name, setName] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [equipmentId, setEquipmentId] = useState('');
  const [sort, setSort] = useState<Sort>('manual');
  // Orden mostrado mientras se guarda un arrastre (sin esperar a la recarga).
  const [pendingOrder, setPendingOrder] = useState<Record<string, string[]>>({});
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
    .sort(
      (a, b) =>
        sort === 'price-asc'
          ? a.priceMinor - b.priceMinor
          : sort === 'price-desc'
            ? b.priceMinor - a.priceMinor
            : sort === 'name'
              ? `${a.device} ${a.title}`.localeCompare(`${b.device} ${b.title}`, 'es')
              : 0, // «Orden del catálogo»: el de la API (equipo → posición → nombre).
    );
  // Orden del catálogo: grupos por equipo, en el orden de categorías y equipos.
  const groups =
    sort === 'manual'
      ? [
          ...categories.flatMap((category) =>
            equipment
              .filter((device) => device.categoryId === category.id)
              .map((device) => {
                const list = visible.filter((item) => item.equipmentId === device.id);
                const order = pendingOrder[device.id];
                return {
                  key: device.id,
                  label: `${category.name} · ${device.name}`,
                  sortable: true,
                  items: order
                    ? [...list].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
                    : list,
                };
              }),
          ),
          {
            key: 'sin-equipo',
            label: 'Sin equipo',
            sortable: false,
            items: visible.filter(
              (item) => !equipment.some((device) => device.id === item.equipmentId),
            ),
          },
        ].filter((group) => group.items.length)
      : [{ key: 'todos', label: '', sortable: false, items: visible }];
  // Con una búsqueda por nombre la lista está incompleta: no se ordena.
  const canSort = sort === 'manual' && !words && !uploading;
  async function saveOrder(equipmentId: string, ids: string[]) {
    setPendingOrder((value) => ({ ...value, [equipmentId]: ids }));
    try {
      await reorder(equipmentId, ids);
    } finally {
      setPendingOrder(({ [equipmentId]: _done, ...rest }) => rest);
    }
  }
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
  const renderService = (item: Offering) => (
    <button
      type="button"
      className={`admin-item admin-service-item${draft.id === item.id ? ' is-selected' : ''}`}
      disabled={uploading}
      aria-current={draft.id === item.id ? 'true' : undefined}
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
        <img src={serviceCover(item)!.thumbnail || serviceCover(item)!.url} alt="" loading="lazy" />
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
  );
  return (
    <div className="admin-layout services-layout">
      <section className="service-list-panel">
        <div className="service-list-head">
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
                <option value="manual">Orden del catálogo (arrastrar)</option>
                <option value="name">Equipo y nombre (A–Z)</option>
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
          {sort === 'manual' && words && items.length > 0 && (
            <p className="small">Quita la búsqueda por nombre para ordenar arrastrando.</p>
          )}
        </div>
        <div className="service-list-scroll">
          {loading && <ListSkeleton label="Cargando catálogo…" count={4} />}
          {!loading && !items.length && <p className="tech-empty">Aún no hay servicios.</p>}
          {!loading && items.length > 0 && !visible.length && (
            <p className="tech-empty">Ningún servicio coincide con los filtros.</p>
          )}
          {groups.map((group) => (
            <div className="service-group-admin" key={group.key}>
              {group.label && <h3 className="service-group-label">{group.label}</h3>}
              {group.sortable && canSort ? (
                <SortableList
                  items={group.items}
                  getId={(item) => item.id}
                  getLabel={(item) => item.title}
                  onReorder={(ids) => void saveOrder(group.key, ids)}
                  renderItem={(item, handle) => (
                    <div className="service-row">
                      {handle}
                      {renderService(item)}
                    </div>
                  )}
                />
              ) : (
                <ul className="sortable">
                  {group.items.map((item) => (
                    <li key={item.id}>{renderService(item)}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
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
            <NumberField
              decimals={2}
              required
              value={draft.priceMinor / 100}
              onValue={(usd) => update('priceMinor', Math.round(Math.min(usd, 100000) * 100))}
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
            <NumberField
              required
              value={draft.durationMinutes}
              onValue={(minutes) => update('durationMinutes', Math.min(minutes, 1440))}
            />
          </label>
          <label>
            Garantía anunciada (días)
            <NumberField
              required
              value={draft.warrantyDays}
              onValue={(days) => update('warrantyDays', Math.min(days, 3650))}
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
