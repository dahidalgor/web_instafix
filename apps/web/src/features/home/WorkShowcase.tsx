import type { SiteSlide } from '@instafix/contracts/src/site';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Skeleton, SkeletonGroup } from '../../components/ui/Skeleton';
import { api } from '../../lib/api';

const INTERVAL_MS = 6500;
const SWIPE_PX = 40;
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * «Nuestro trabajo»: avance automático con control manual (flechas, puntos, deslizar).
 * Pasar el ratón por encima o enfocar NO lo pausa; navegar a mano reinicia el intervalo y
 * el avance continúa. Solo el botón «Pausar» lo detiene. Sin avance con movimiento reducido.
 */
export function WorkShowcase() {
  const [slides, setSlides] = useState<SiteSlide[] | null>(null);
  const [error, setError] = useState('');
  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(() => !reducedMotion());
  // Cambia con cada navegación manual para reiniciar el intervalo sin detenerlo.
  const [tick, setTick] = useState(0);
  const swipe = useRef<{ x: number; y: number; id: number } | null>(null);
  const load = () => {
    setError('');
    api<SiteSlide[]>('slides')
      .then(setSlides)
      .catch((e) => setError(e.message));
  };
  useEffect(load, []);
  const count = slides?.length ?? 0;
  useEffect(() => {
    if (count < 2 || !playing || reducedMotion()) return;
    const timer = window.setInterval(() => setCurrent((value) => (value + 1) % count), INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [playing, count, tick]);
  useEffect(() => {
    if (count && window.location.hash === '#nuestro-trabajo')
      document.getElementById('nuestro-trabajo')?.scrollIntoView();
  }, [count]);
  function change(index: number) {
    setCurrent((index + count) % count);
    setTick((value) => value + 1);
  }
  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    swipe.current = { x: event.clientX, y: event.clientY, id: event.pointerId };
  }
  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const start = swipe.current;
    swipe.current = null;
    if (!start || start.id !== event.pointerId || count < 2) return;
    const dx = event.clientX - start.x;
    // Solo gestos claramente horizontales: el desplazamiento vertical de la página sigue igual.
    if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(event.clientY - start.y))
      change(current + (dx < 0 ? 1 : -1));
  }

  if (error)
    return (
      <p role="alert" className="work-error">
        {error}{' '}
        <button type="button" className="btn btn-ghost btn-small" onClick={load}>
          Reintentar
        </button>
      </p>
    );
  if (!slides)
    return (
      <SkeletonGroup label="Cargando presentación…" className="work-showcase is-loading">
        <div className="work-visual">
          <Skeleton width="100%" height="100%" radius={0} className="work-skeleton-visual" />
        </div>
        <div className="work-story">
          <Skeleton width="40%" height={12} />
          <div className="work-copy">
            <Skeleton width="30%" height={10} />
            <Skeleton width="85%" height={34} />
            <Skeleton width="100%" height={14} />
            <Skeleton width="90%" height={14} />
          </div>
        </div>
      </SkeletonGroup>
    );
  // Sin diapositivas publicadas la sección no se muestra (no se inventa contenido).
  const slide = slides[current];
  if (!slide) return null;
  return (
    <section
      id="nuestro-trabajo"
      className="work-showcase"
      aria-label="Presentación de nuestro trabajo"
      aria-roledescription="carrusel"
    >
      <div
        className={'work-visual work-visual-' + (current % 3)}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (swipe.current = null)}
      >
        {slide.media[0] ? (
          slide.media[0].type === 'image' ? (
            <img
              src={slide.media[0].url}
              alt={slide.media[0].alt || slide.title}
              draggable={false}
            />
          ) : (
            <video
              key={slide.media[0].url}
              src={slide.media[0].url}
              poster={slide.media[0].poster}
              controls
              muted
              playsInline
              preload="metadata"
              aria-label={slide.media[0].alt || slide.title}
            />
          )
        ) : (
          <>
            <div className="work-grid" />
            <div className="work-orbit" />
            <span className="work-symbol" aria-hidden="true">
              {slide.symbol}
            </span>
            <span className="work-placeholder">
              Ilustración · Fotos de nuestros trabajos próximamente
            </span>
          </>
        )}
        <span className="work-overline">INSTAFIX / EN ACCIÓN</span>
        <span className="work-detail">{slide.detail}</span>
      </div>
      <div className="work-story">
        <div className="work-heading">
          <span className="eyebrow">NUESTRO TRABAJO</span>
          <span className="work-count">
            {String(current + 1).padStart(2, '0')} / {String(slides.length).padStart(2, '0')}
          </span>
        </div>
        <div className="work-copy" aria-live={playing ? 'off' : 'polite'} aria-atomic="true">
          <p className="work-category">{slide.label}</p>
          <h3>{slide.title}</h3>
          <p>{slide.description}</p>
        </div>
        {slides.length > 1 && (
          <>
            <div className="work-controls">
              <div className="work-dots">
                {slides.map((item, index) => (
                  <button
                    key={item.id}
                    aria-label={'Ver ' + item.label.toLowerCase()}
                    aria-pressed={index === current}
                    className={index === current ? 'selected' : ''}
                    onClick={() => change(index)}
                  />
                ))}
              </div>
              <div className="work-arrows">
                <button aria-label="Diapositiva anterior" onClick={() => change(current - 1)}>
                  ←
                </button>
                <button aria-label="Diapositiva siguiente" onClick={() => change(current + 1)}>
                  →
                </button>
              </div>
            </div>
            {!reducedMotion() && (
              <button className="work-play" onClick={() => setPlaying((value) => !value)}>
                {playing ? 'Ⅱ Pausar presentación' : '▷ Reproducir presentación'}
              </button>
            )}
          </>
        )}
      </div>
    </section>
  );
}
