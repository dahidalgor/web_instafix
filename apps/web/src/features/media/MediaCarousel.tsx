import type { Offering } from '@instafix/contracts';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

/** Tras una interacción manual, el desplazamiento automático se reanuda solo (sin quedar detenido). */
const RESUME_AFTER_MS = 2500;
/** Misma velocidad que la animación anterior: un grupo completo cada 35 s. */
const LOOP_SECONDS = 35;

/**
 * «Nuestro trabajo»: desplazamiento continuo y, a la vez, control manual (deslizar en móvil,
 * arrastrar con el ratón, rueda/trackpad y flechas). Pasar el ratón por encima NO lo pausa.
 * Con movimiento reducido no hay desplazamiento automático; el control manual se mantiene.
 */
export function MediaCarousel({ media }: { media: Offering['media'] }) {
  const viewport = useRef<HTMLDivElement>(null);
  const group = useRef<HTMLDivElement>(null);
  const [reduced, setReduced] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const change = () => setReduced(query.matches);
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);
  const stopped = reduced;
  // Interacción manual: pausa breve del avance automático, nunca permanente.
  const interactedAt = useRef(0);
  const position = useRef(0);
  const drag = useRef<{ x: number; left: number; id: number } | null>(null);
  const touch = () => {
    interactedAt.current = performance.now();
  };

  // Avance automático con requestAnimationFrame sobre el desplazamiento nativo del contenedor.
  useEffect(() => {
    const root = viewport.current;
    const first = group.current;
    if (!root || !first || stopped || !media.length) return;
    let frame = 0;
    let last = performance.now();
    let visible = true;
    position.current = root.scrollLeft;
    const loopWidth = () => first.offsetWidth;
    const step = (now: number) => {
      frame = requestAnimationFrame(step);
      const dt = Math.min(64, now - last);
      last = now;
      const width = loopWidth();
      if (!visible || document.hidden || !width) return;
      if (drag.current || now - interactedAt.current < RESUME_AFTER_MS) {
        position.current = root.scrollLeft;
        return;
      }
      // Se guarda la posición en coma flotante: scrollLeft redondea y frenaría el avance.
      position.current += (width / LOOP_SECONDS) * (dt / 1000);
      if (position.current >= width) position.current -= width;
      root.scrollLeft = position.current;
    };
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
    });
    observer.observe(root);
    frame = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [media, stopped]);

  // Bucle infinito también al desplazar a mano: el grupo duplicado permite volver sin salto.
  function keepInLoop() {
    const root = viewport.current;
    const width = group.current?.offsetWidth;
    if (!root || !width || stopped) return;
    if (root.scrollLeft >= width) root.scrollLeft -= width;
    else if (root.scrollLeft <= 0 && drag.current) root.scrollLeft += width;
  }

  function move(direction: 1 | -1) {
    const root = viewport.current;
    const figure = root?.querySelector('figure');
    if (!root || !figure) return;
    touch();
    const width = group.current?.offsetWidth ?? 0;
    // Hacia atrás desde el inicio: primero se salta a la copia para no chocar con el borde.
    if (direction < 0 && root.scrollLeft < figure.clientWidth && width && !stopped)
      root.scrollLeft += width;
    root.scrollBy({ left: direction * figure.clientWidth, behavior: reduced ? 'auto' : 'smooth' });
  }

  // Arrastre con ratón (en táctil el desplazamiento nativo ya permite deslizar).
  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType !== 'mouse' || event.button !== 0 || !viewport.current) return;
    drag.current = { x: event.clientX, left: viewport.current.scrollLeft, id: event.pointerId };
    touch();
  }
  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const state = drag.current;
    const root = viewport.current;
    if (!state || !root || event.pointerId !== state.id) return;
    const dx = event.clientX - state.x;
    if (Math.abs(dx) > 4 && !root.hasPointerCapture(state.id)) root.setPointerCapture(state.id);
    root.scrollLeft = state.left - dx;
    touch();
  }
  function endDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (!drag.current || event.pointerId !== drag.current.id) return;
    drag.current = null;
    touch();
  }

  // Vídeos: siempre silenciados; solo se reproducen mientras se ven (reglas existentes).
  useEffect(() => {
    const root = viewport.current;
    if (!root) return;
    const videos = Array.from(root.querySelectorAll('video'));
    const visible = new Set<HTMLVideoElement>();
    const update = () =>
      videos.forEach((video) => {
        if (visible.has(video) && !document.hidden && !stopped) void video.play().catch(() => {});
        else video.pause();
      });
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const video = entry.target as HTMLVideoElement;
          if (entry.isIntersecting) visible.add(video);
          else visible.delete(video);
        });
        update();
      },
      { threshold: 0.1 },
    );
    videos.forEach((video) => {
      video.muted = true;
      observer.observe(video);
    });
    document.addEventListener('visibilitychange', update);
    return () => {
      observer.disconnect();
      videos.forEach((video) => video.pause());
      document.removeEventListener('visibilitychange', update);
    };
  }, [media, stopped]);

  if (!media.length) return null;
  return (
    <section className="media-gallery" aria-label="Fotos y videos del servicio">
      <div className="media-toolbar">
        <span>Nuestro trabajo</span>
        {media.length > 1 && (
          <div className="media-arrows">
            <button type="button" aria-label="Ver anterior" onClick={() => move(-1)}>
              ←
            </button>
            <button type="button" aria-label="Ver siguiente" onClick={() => move(1)}>
              →
            </button>
          </div>
        )}
      </div>
      <div
        className={`media-viewport ${reduced ? 'is-reduced' : ''}`}
        ref={viewport}
        tabIndex={0}
        aria-label="Galería de nuestro trabajo. Desliza o usa las flechas para recorrerla."
        onScroll={keepInLoop}
        onWheel={touch}
        onTouchStart={touch}
        onTouchMove={touch}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight') move(1);
          if (event.key === 'ArrowLeft') move(-1);
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDragStart={(event) => event.preventDefault()}
      >
        <div className="media-track">
          {[0, 1].map((copy) => (
            <div
              key={copy}
              ref={copy ? undefined : group}
              className={`media-group ${copy ? 'media-copy' : ''}`}
              aria-hidden={copy ? true : undefined}
            >
              {media.map((item, index) => (
                <figure key={index}>
                  {item.type === 'image' ? (
                    <img
                      src={item.url}
                      srcSet={
                        item.thumbnail ? `${item.thumbnail} 640w, ${item.url} 1600w` : undefined
                      }
                      sizes="(max-width: 700px) 90vw, 640px"
                      alt={copy ? '' : item.alt}
                      loading="lazy"
                      draggable={false}
                    />
                  ) : (
                    <video
                      src={item.url}
                      poster={item.poster}
                      muted
                      loop
                      playsInline
                      preload="none"
                      controls={!copy && stopped}
                      tabIndex={copy ? -1 : 0}
                      aria-label={item.alt || 'Video de nuestro trabajo'}
                    />
                  )}
                </figure>
              ))}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
