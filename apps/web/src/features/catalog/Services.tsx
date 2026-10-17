import { serviceCover, type Offering } from '@instafix/contracts';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { money } from '../../lib/format';
import { MediaCarousel } from '../media/MediaCarousel';
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
      {loading && <p role="status">Cargando servicios…</p>}
      {error && (
        <p role="alert">
          {error} <button onClick={load}>Reintentar</button>
        </p>
      )}
      {!loading && !error && !items.length && <p>Pronto publicaremos nuestros servicios.</p>}
      <div className="cards">
        {items
          .filter((item) => device === 'Todos' || item.device === device)
          .map((item) => (
            <button className="card" key={item.id} onClick={() => setSelected(item)}>
              {serviceCover(item) ? (
                <img
                  className="service-cover"
                  src={serviceCover(item)!.thumbnail || serviceCover(item)!.url}
                  srcSet={
                    serviceCover(item)!.thumbnail
                      ? `${serviceCover(item)!.thumbnail} 640w, ${serviceCover(item)!.url} 1600w`
                      : undefined
                  }
                  sizes="(max-width: 700px) 90vw, 380px"
                  alt=""
                  loading="lazy"
                />
              ) : (
                <div className="card-icon">
                  ✦<span>Ver detalles ↗</span>
                </div>
              )}
              <span className={'badge ' + item.availability}>
                {availabilityLabels[item.availability]}
              </span>
              <p className="eyebrow">{item.device}</p>
              <h3>{item.title}</h3>
              <div className="price">
                <strong>{money(item.priceMinor)}</strong>
                <span>Ver servicio ↗</span>
              </div>
            </button>
          ))}
      </div>
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
            {selected.cover && (
              <img
                className="service-detail-cover"
                src={selected.cover.url}
                srcSet={
                  selected.cover.thumbnail
                    ? `${selected.cover.thumbnail} 640w, ${selected.cover.url} 1600w`
                    : undefined
                }
                sizes="(max-width: 700px) 90vw, 640px"
                alt={selected.cover.alt}
              />
            )}
            <MediaCarousel media={selected.media} />
            <p className="service-description">{selected.description}</p>
            <strong className="service-price">{money(selected.priceMinor)}</strong>
            <p>{selected.durationMinutes} minutos estimados</p>
            {selected.warrantyDays > 0 && (
              <p>
                Garantía: {selected.warrantyDays} días. Consulta las condiciones antes de contratar.
              </p>
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
