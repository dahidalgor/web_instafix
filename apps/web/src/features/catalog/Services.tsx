import { serviceCover, type Offering } from '@instafix/contracts';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { money } from '../../lib/format';
import { ServiceCardSkeleton, SkeletonGroup } from '../../components/ui/Skeleton';
import { MediaCarousel } from '../media/MediaCarousel';
import { ServiceFacts } from './ServiceFacts';
import { availabilityLabels } from './catalog.constants';

export function Services() {
  const [items, setItems] = useState<Offering[]>([]);
  const [device, setDevice] = useState('Todos');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Offering | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  function load() {
    setLoading(true);
    setError('');
    api<Offering[]>('catalog')
      .then(setItems)
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
      <div className="filters">
        {['Todos', ...new Set(items.map((item) => item.device))].map((name) => (
          <button
            key={name}
            className={device === name ? 'active' : ''}
            onClick={() => setDevice(name)}
          >
            {name}
          </button>
        ))}
      </div>
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
      {!loading && !error && (
        <div className="cards">
          {items
            .filter((item) => device === 'Todos' || item.device === device)
            .map((item) => {
              const cover = serviceCover(item);
              return (
                <button
                  className="card service-card"
                  key={item.id}
                  onClick={() => setSelected(item)}
                  aria-label={`${item.title}, ${item.device}, ${money(item.priceMinor)}, ${availabilityLabels[item.availability]}. Ver detalles`}
                >
                  {cover ? (
                    <img
                      className="service-cover"
                      src={cover.thumbnail || cover.url}
                      srcSet={
                        cover.thumbnail ? `${cover.thumbnail} 640w, ${cover.url} 1600w` : undefined
                      }
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
            })}
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
            <p className="eyebrow">{selected.device}</p>
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
