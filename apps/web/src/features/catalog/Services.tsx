import { serviceCover, type Offering, type ServiceCategory } from '@instafix/contracts';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { api } from '../../lib/api';
import { money } from '../../lib/format';
import { ServiceCardSkeleton, SkeletonGroup } from '../../components/ui/Skeleton';
import { SlidingIndicator } from '../../components/ui/SlidingIndicator';
import { MediaCarousel } from '../media/MediaCarousel';
import { ServiceFacts } from './ServiceFacts';
import { availabilityLabels } from './catalog.constants';

const ALL = 'Todos';
/** Comparación sin mayúsculas ni tildes: «bateria» encuentra «Batería». */
const fold = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

/** Catálogo público: Categoría → Equipo → Servicio. */
export function Services() {
  const [items, setItems] = useState<Offering[]>([]);
  const [categories, setCategories] = useState<ServiceCategory[]>([]);
  const [category, setCategory] = useState(ALL);
  const [device, setDevice] = useState(ALL);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Offering | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  function load() {
    setLoading(true);
    setError('');
    Promise.all([
      api<Offering[]>('catalog'),
      // Sin el orden de categorías el catálogo sigue funcionando (orden alfabético).
      api<ServiceCategory[]>('categories').catch(() => []),
    ])
      .then(([offerings, groups]) => {
        setItems(offerings);
        setCategories(groups);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }
  useEffect(load, []);
  useEffect(() => {
    if (!selected) {
      dialog.current?.close();
      return;
    }
    dialog.current?.showModal();
    // El fondo no debe desplazarse mientras el diálogo está abierto.
    document.body.classList.add('service-dialog-open');
    return () => {
      document.body.classList.remove('service-dialog-open');
    };
  }, [selected]);
  // Solo se muestran las categorías con servicios publicados, en el orden de administración.
  const present = new Set(items.map((item) => item.category));
  const groups = [
    ...categories.map((item) => item.name).filter((name) => present.has(name)),
    ...[...present].filter((name) => !categories.some((item) => item.name === name)).sort(),
  ];
  const inCategory = items.filter((item) => category === ALL || item.category === category);
  // El filtro de equipo aparece dentro de una categoría (o si solo hay una).
  const devices =
    category === ALL && groups.length > 1
      ? []
      : [...new Set(inCategory.map((item) => item.device))];
  // La búsqueda mira solo el nombre del servicio (no la descripción) y respeta los filtros.
  const words = fold(search.trim());
  const visible = inCategory
    .filter((item) => device === ALL || item.device === device)
    .filter((item) => !words || fold(item.title).includes(words));
  const chooseCategory = (name: string) => {
    setCategory(name);
    setDevice(ALL);
  };
  return (
    <section id="servicios">
      <div className="section-head">
        <div>
          <p className="eyebrow">EL CUIDADO QUE TU EQUIPO NECESITA</p>
          <h2>
            Un servicio para
            <br />
            cada equipo.
          </h2>
        </div>
        <p>Conoce el alcance, el precio y la disponibilidad.</p>
      </div>
      {items.length > 0 && (
        <label className="service-search">
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            type="search"
            value={search}
            maxLength={80}
            aria-label="Buscar servicio por nombre"
            placeholder="Buscar servicio por nombre"
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
      )}
      {groups.length > 1 && (
        <div className="filters category-filters has-indicator" role="group" aria-label="Categoría">
          {[ALL, ...groups].map((name) => (
            <button
              key={name}
              aria-pressed={category === name}
              className={category === name ? 'active' : ''}
              onClick={() => chooseCategory(name)}
            >
              {name === ALL ? 'Todas' : name}
            </button>
          ))}
          <SlidingIndicator selector=".active" watch={category} />
        </div>
      )}
      {devices.length > 1 && (
        <div className="filters device-filters has-indicator" role="group" aria-label="Equipo">
          {[ALL, ...devices].map((name) => (
            <button
              key={name}
              aria-pressed={device === name}
              className={device === name ? 'active' : ''}
              onClick={() => setDevice(name)}
            >
              {name}
            </button>
          ))}
          <SlidingIndicator selector=".active" watch={`${category}/${device}`} />
        </div>
      )}
      {loading && (
        <div className="cards">
          <SkeletonGroup label="Cargando servicios…">
            {Array.from({ length: 6 }, (_, i) => (
              <ServiceCardSkeleton key={i} />
            ))}
          </SkeletonGroup>
        </div>
      )}
      {error && (
        <p role="alert">
          {error}{' '}
          <button className="btn btn-ghost btn-small" onClick={load}>
            Reintentar
          </button>
        </p>
      )}
      {!loading && !error && !items.length && <p>Pronto publicaremos nuestros servicios.</p>}
      {!loading && !error && items.length > 0 && !visible.length && (
        <p className="service-empty" role="status">
          Ningún servicio se llama «{search.trim()}»
          {category !== ALL || device !== ALL ? ' en este filtro' : ''}.{' '}
          <button type="button" className="btn btn-ghost btn-small" onClick={() => setSearch('')}>
            Quitar búsqueda
          </button>
        </p>
      )}
      {!loading && !error && (
        // Cambiar de categoría o de equipo vuelve a montar el listado y las tarjetas entran
        // escalonadas.
        <div className="service-results" key={`${category}/${device}`}>
          {groups
            .filter((name) => visible.some((item) => item.category === name))
            .map((name) => (
              <div className="service-group" key={name}>
                <h3 className="service-group-title">{name}</h3>
                <div className="cards">
                  {visible
                    .filter((item) => item.category === name)
                    .map((item, index) => (
                      <ServiceCard
                        key={item.id}
                        item={item}
                        index={index}
                        onOpen={() => setSelected(item)}
                      />
                    ))}
                </div>
              </div>
            ))}
        </div>
      )}
      <dialog
        ref={dialog}
        className="service-dialog"
        aria-labelledby="service-detail-title"
        onCancel={() => setSelected(null)}
        onClick={(event) => {
          if (event.target === event.currentTarget) setSelected(null);
        }}
      >
        {selected && (
          <article>
            <button
              className="dialog-close"
              aria-label="Cerrar detalle"
              onClick={() => setSelected(null)}
            >
              ×
            </button>
            <p className="eyebrow">
              {selected.category} · {selected.device}
            </p>
            <h2 id="service-detail-title">{selected.title}</h2>
            <span className={'badge ' + selected.availability}>
              {availabilityLabels[selected.availability]}
            </span>
            <MediaCarousel media={selected.media} />
            <p className="service-description">{selected.description}</p>
            <div className="service-summary">
              <strong className="service-price">{money(selected.priceMinor)}</strong>
              <ServiceFacts
                durationMinutes={selected.durationMinutes}
                warrantyDays={selected.warrantyDays}
              />
            </div>
            {selected.warrantyDays > 0 && (
              <p className="small">Consulta las condiciones de la garantía antes de contratar.</p>
            )}
            {selected.availability === 'AVAILABLE' ? (
              <a className="button" href="#agenda" onClick={() => setSelected(null)}>
                Consultar horarios ↗
              </a>
            ) : (
              <p>Este servicio no admite solicitudes en este momento.</p>
            )}
            <p className="small">
              Cuéntanos qué necesita tu equipo al reservar. El técnico definirá contigo el servicio
              adecuado.
            </p>
          </article>
        )}
      </dialog>
    </section>
  );
}

function ServiceCard({
  item,
  index,
  onOpen,
}: {
  item: Offering;
  index: number;
  onOpen: () => void;
}) {
  const cover = serviceCover(item);
  return (
    <button
      className="card service-card"
      style={{ '--i': Math.min(index, 8) } as CSSProperties}
      onClick={onOpen}
      aria-label={`${item.title}, ${item.category}, ${item.device}, ${money(item.priceMinor)}, ${availabilityLabels[item.availability]}. Ver detalles`}
    >
      {cover ? (
        <img
          className="service-cover"
          src={cover.thumbnail || cover.url}
          srcSet={cover.thumbnail ? `${cover.thumbnail} 640w, ${cover.url} 1600w` : undefined}
          sizes="(max-width: 700px) 90vw, 380px"
          alt=""
          loading="lazy"
        />
      ) : (
        <span className="card-icon" aria-hidden="true">
          ✦
        </span>
      )}
      <span className="service-card-top">
        <span className="eyebrow">{item.device}</span>
        <span className={'badge ' + item.availability}>
          {availabilityLabels[item.availability]}
        </span>
      </span>
      <span className="service-card-title">{item.title}</span>
      <span className="service-card-bottom">
        <strong className="service-card-price">{money(item.priceMinor)}</strong>
        <ServiceFacts
          durationMinutes={item.durationMinutes}
          warrantyDays={item.warrantyDays}
          compact
        />
      </span>
    </button>
  );
}
