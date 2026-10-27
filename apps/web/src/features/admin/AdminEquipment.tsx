import type { CatalogEquipment, Offering, ServiceCategory } from '@instafix/contracts';
import { useState, type FormEvent } from 'react';
import { BusyButton } from '../../components/ui/BusyButton';
import { ListSkeleton } from '../../components/ui/Skeleton';
import { SortableList } from '../../components/ui/SortableList';
import { api } from '../../lib/api';

type Props = {
  categories: ServiceCategory[];
  equipment: CatalogEquipment[];
  services: Offering[];
  load: () => Promise<void>;
  loading?: boolean;
};
type Editing =
  | { kind: 'category'; id: string; name: string }
  | { kind: 'equipment'; id: string; name: string; categoryId: string }
  | null;

/**
 * Administración → Categorías y equipos: Categoría → Equipo → Servicio
 * (p. ej. Consolas de Videojuegos → PS5 → Mantenimiento). La API valida cada cambio.
 */
export function AdminEquipment({ categories, equipment, services, load, loading }: Props) {
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [newCategory, setNewCategory] = useState('');
  const [newDevice, setNewDevice] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<Editing>(null);

  async function act(key: string, action: () => Promise<unknown>, done: string) {
    setBusyKey(key);
    setMessage('');
    try {
      await action();
      await load();
      setMessage(done);
      return true;
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'No se pudo guardar');
      return false;
    } finally {
      setBusyKey(null);
    }
  }
  const send = (path: string, method: string, body?: unknown) =>
    api(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

  async function addCategory(event: FormEvent) {
    event.preventDefault();
    if (
      await act(
        'category:new',
        () => send('admin/categories', 'POST', { name: newCategory }),
        'Categoría creada.',
      )
    )
      setNewCategory('');
  }
  async function addDevice(event: FormEvent, categoryId: string) {
    event.preventDefault();
    const name = newDevice[categoryId] || '';
    if (
      await act(
        `device:new:${categoryId}`,
        () => send('admin/equipment', 'POST', { name, categoryId }),
        'Equipo añadido.',
      )
    )
      setNewDevice((value) => ({ ...value, [categoryId]: '' }));
  }
  async function saveEdit(event: FormEvent) {
    event.preventDefault();
    if (!editing) return;
    const ok =
      editing.kind === 'category'
        ? await act(
            `category:${editing.id}`,
            () => send(`admin/categories/${editing.id}`, 'PATCH', { name: editing.name }),
            'Categoría actualizada.',
          )
        : await act(
            `device:${editing.id}`,
            () =>
              send(`admin/equipment/${editing.id}`, 'PATCH', {
                name: editing.name,
                categoryId: editing.categoryId,
              }),
            'Equipo actualizado; sus servicios muestran el cambio.',
          );
    if (ok) setEditing(null);
  }
  // Orden de las categorías en el catálogo público: se intercambia con la vecina.
  function moveCategory(index: number, direction: -1 | 1) {
    const current = categories[index];
    const other = categories[index + direction];
    if (!current || !other) return;
    return act(
      `category:move:${current.id}:${direction}`,
      async () => {
        const ordered = categories.map((item, i) => ({ id: item.id, position: i }));
        ordered[index].position = index + direction;
        ordered[index + direction].position = index;
        // Solo se guardan las posiciones que cambian (también normaliza órdenes antiguos).
        await Promise.all(
          ordered
            .filter((item) => categories.find((c) => c.id === item.id)?.position !== item.position)
            .map((item) =>
              send(`admin/categories/${item.id}`, 'PATCH', { position: item.position }),
            ),
        );
      },
      'Orden actualizado.',
    );
  }
  const busy = busyKey !== null;
  const servicesOf = (id: string) => services.filter((item) => item.equipmentId === id).length;
  // Orden mostrado mientras se guarda un arrastre (sin esperar a la recarga).
  const [pendingOrder, setPendingOrder] = useState<Record<string, string[]>>({});
  const sortedDevices = (categoryId: string) => {
    const list = equipment.filter((item) => item.categoryId === categoryId);
    const order = pendingOrder[categoryId];
    return order ? [...list].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)) : list;
  };
  async function reorderDevices(categoryId: string, ids: string[]) {
    setPendingOrder((value) => ({ ...value, [categoryId]: ids }));
    await act(
      `device:order:${categoryId}`,
      () => send(`admin/categories/${categoryId}/equipment-order`, 'PUT', { ids }),
      'Orden de los equipos guardado; la web lo muestra en este orden.',
    );
    setPendingOrder(({ [categoryId]: _done, ...rest }) => rest);
  }

  return (
    <section className="catalog-admin">
      <p className="small">
        El catálogo se organiza en Categoría → Equipo → Servicio, por ejemplo «Consolas de
        Videojuegos → PS5 → Mantenimiento». Las categorías con servicios aparecen en la página
        pública en este orden. Un equipo desactivado se oculta de la página junto con sus servicios,
        sin borrar nada.
      </p>
      {message && (
        <p role="status" className="admin-message">
          {message}
        </p>
      )}
      <form className="catalog-admin-new" onSubmit={addCategory}>
        <label>
          Nueva categoría
          <input
            required
            minLength={2}
            maxLength={80}
            placeholder="PC y Laptops"
            value={newCategory}
            onChange={(e) => setNewCategory(e.target.value)}
          />
        </label>
        <BusyButton
          type="submit"
          className="btn btn-primary"
          busy={busyKey === 'category:new'}
          disabled={busy}
          busyLabel="Creando…"
        >
          Añadir categoría
        </BusyButton>
      </form>
      {loading && <ListSkeleton label="Cargando categorías…" count={2} />}
      {!loading && !categories.length && (
        <p className="tech-empty">
          Todavía no hay categorías. Crea la primera para añadir equipos.
        </p>
      )}
      <div className="catalog-admin-list">
        {categories.map((category, index) => {
          const devices = sortedDevices(category.id);
          const editingCategory = editing?.kind === 'category' && editing.id === category.id;
          return (
            <article key={category.id} className="catalog-admin-category">
              <header>
                {editingCategory ? (
                  <form className="catalog-admin-inline" onSubmit={saveEdit}>
                    <input
                      aria-label="Nombre de la categoría"
                      required
                      minLength={2}
                      maxLength={80}
                      autoFocus
                      value={editing.name}
                      onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                    />
                    <BusyButton
                      type="submit"
                      className="btn btn-primary btn-small"
                      busy={busyKey === `category:${category.id}`}
                      disabled={busy}
                      busyLabel="Guardando…"
                    >
                      Guardar
                    </BusyButton>
                    <button
                      type="button"
                      className="btn btn-ghost btn-small"
                      onClick={() => setEditing(null)}
                    >
                      Cancelar
                    </button>
                  </form>
                ) : (
                  <>
                    <div>
                      <span className="eyebrow">Categoría</span>
                      <h3>{category.name}</h3>
                    </div>
                    <div className="tech-actions-row">
                      <BusyButton
                        type="button"
                        className="btn btn-ghost btn-small"
                        aria-label={`Subir ${category.name}`}
                        disabled={busy || index === 0}
                        busy={busyKey === `category:move:${category.id}:-1`}
                        onClick={() => moveCategory(index, -1)}
                      >
                        ↑
                      </BusyButton>
                      <BusyButton
                        type="button"
                        className="btn btn-ghost btn-small"
                        aria-label={`Bajar ${category.name}`}
                        disabled={busy || index === categories.length - 1}
                        busy={busyKey === `category:move:${category.id}:1`}
                        onClick={() => moveCategory(index, 1)}
                      >
                        ↓
                      </BusyButton>
                      <button
                        type="button"
                        className="btn btn-secondary btn-small"
                        disabled={busy}
                        onClick={() =>
                          setEditing({ kind: 'category', id: category.id, name: category.name })
                        }
                      >
                        Renombrar
                      </button>
                      {!devices.length && (
                        <BusyButton
                          type="button"
                          className="btn btn-danger btn-small"
                          disabled={busy}
                          busy={busyKey === `category:delete:${category.id}`}
                          busyLabel="Eliminando…"
                          onClick={() =>
                            act(
                              `category:delete:${category.id}`,
                              () => send(`admin/categories/${category.id}`, 'DELETE'),
                              'Categoría eliminada.',
                            )
                          }
                        >
                          Eliminar
                        </BusyButton>
                      )}
                    </div>
                  </>
                )}
              </header>
              <SortableList
                className="catalog-admin-devices"
                items={devices}
                getId={(device) => device.id}
                getLabel={(device) => device.name}
                disabled={busy || editing !== null}
                onReorder={(ids) => void reorderDevices(category.id, ids)}
                renderItem={(device, handle) => {
                  const count = servicesOf(device.id);
                  const editingDevice = editing?.kind === 'equipment' && editing.id === device.id;
                  return (
                    <div
                      className={`catalog-admin-device${device.active === false ? ' is-inactive' : ''}`}
                    >
                      {!editingDevice && handle}
                      {editingDevice ? (
                        <form className="catalog-admin-inline" onSubmit={saveEdit}>
                          <input
                            aria-label="Nombre del equipo"
                            required
                            minLength={2}
                            maxLength={80}
                            autoFocus
                            value={editing.name}
                            onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                          />
                          <select
                            aria-label="Categoría del equipo"
                            value={editing.categoryId}
                            onChange={(e) => setEditing({ ...editing, categoryId: e.target.value })}
                          >
                            {categories.map((item) => (
                              <option key={item.id} value={item.id}>
                                {item.name}
                              </option>
                            ))}
                          </select>
                          <BusyButton
                            type="submit"
                            className="btn btn-primary btn-small"
                            busy={busyKey === `device:${device.id}`}
                            disabled={busy}
                            busyLabel="Guardando…"
                          >
                            Guardar
                          </BusyButton>
                          <button
                            type="button"
                            className="btn btn-ghost btn-small"
                            onClick={() => setEditing(null)}
                          >
                            Cancelar
                          </button>
                        </form>
                      ) : (
                        <>
                          <span>
                            <strong>{device.name}</strong>
                            <small>
                              {count === 1 ? '1 servicio' : `${count} servicios`}
                              {device.active === false && (
                                <span className="equipment-off"> · Desactivado: no se publica</span>
                              )}
                            </small>
                          </span>
                          <span className="tech-actions-row">
                            <BusyButton
                              type="button"
                              className="btn btn-secondary btn-small"
                              disabled={busy}
                              busy={busyKey === `device:toggle:${device.id}`}
                              busyLabel="Guardando…"
                              onClick={() =>
                                act(
                                  `device:toggle:${device.id}`,
                                  () =>
                                    send(`admin/equipment/${device.id}`, 'PATCH', {
                                      active: device.active === false,
                                    }),
                                  device.active === false
                                    ? `${device.name} activado: sus servicios vuelven a publicarse.`
                                    : `${device.name} desactivado: sus servicios ya no aparecen en la página.`,
                                )
                              }
                            >
                              {device.active === false ? 'Activar' : 'Desactivar'}
                            </BusyButton>
                            <button
                              type="button"
                              className="btn btn-ghost btn-small"
                              disabled={busy}
                              onClick={() =>
                                setEditing({
                                  kind: 'equipment',
                                  id: device.id,
                                  name: device.name,
                                  categoryId: device.categoryId,
                                })
                              }
                            >
                              Editar
                            </button>
                            {!count && (
                              <BusyButton
                                type="button"
                                className="btn btn-ghost btn-small"
                                disabled={busy}
                                busy={busyKey === `device:delete:${device.id}`}
                                busyLabel="Eliminando…"
                                onClick={() =>
                                  act(
                                    `device:delete:${device.id}`,
                                    () => send(`admin/equipment/${device.id}`, 'DELETE'),
                                    'Equipo eliminado.',
                                  )
                                }
                              >
                                Eliminar
                              </BusyButton>
                            )}
                          </span>
                        </>
                      )}
                    </div>
                  );
                }}
              />
              <form
                className="catalog-admin-inline"
                onSubmit={(e) => void addDevice(e, category.id)}
              >
                <input
                  aria-label={`Nuevo equipo en ${category.name}`}
                  required
                  minLength={2}
                  maxLength={80}
                  placeholder="Nuevo equipo, p. ej. PS5"
                  value={newDevice[category.id] || ''}
                  onChange={(e) =>
                    setNewDevice((value) => ({ ...value, [category.id]: e.target.value }))
                  }
                />
                <BusyButton
                  type="submit"
                  className="btn btn-secondary btn-small"
                  busy={busyKey === `device:new:${category.id}`}
                  disabled={busy}
                  busyLabel="Añadiendo…"
                >
                  Añadir equipo
                </BusyButton>
              </form>
            </article>
          );
        })}
      </div>
    </section>
  );
}
