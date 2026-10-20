import type { Offering } from '@instafix/contracts';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

/** Tras desplazar a mano, el avance automático se detiene un momento y luego se reanuda. */
const RESUME_AFTER_MS = 3000;
/** Velocidad del avance automático, en píxeles por segundo. */
const SPEED = 45;
/** Píxeles de arrastre antes de considerarlo un desplazamiento horizontal. */
const DRAG_THRESHOLD = 6;

/**
 * Galería del servicio: avanza sola de forma continua y el usuario puede desplazarla
 * (deslizar en móvil, arrastrar con el ratón, rueda o trackpad horizontal, flechas del
 * teclado). Al desplazarla, el avance se detiene unos segundos y continúa desde ahí.
 * Se mueve con transform, no con el scroll nativo, para comportarse igual en todos los
 * navegadores (incluido Safari). Con movimiento reducido no avanza solo.
 */
export function MediaCarousel({ media }: { media: Offering['media'] }) {
  const viewport = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
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
  const offset = useRef(0);
  const velocity = useRef(0);
  const interactedAt = useRef(-Infinity);
  const drag = useRef<{
    id: number;
    x: number;
    y: number;
    start: number;
    lastX: number;
    lastT: number;
    horizontal: boolean | null;
  } | null>(null);
  const touch = () => {
    interactedAt.current = performance.now();
  };

  /** Bucle infinito con la copia del grupo; sin copia (movimiento reducido), con topes. */
  function normalize(value: number) {
    const width = group.current?.offsetWidth ?? 0;
    if (!width) return 0;
    if (!stopped) return ((value % width) + width) % width;
    const max = Math.max(0, width - (viewport.current?.clientWidth ?? 0));
    return Math.min(max, Math.max(0, value));
  }
  function paint() {
    if (track.current) track.current.style.transform = `translate3d(${-offset.current}px, 0, 0)`;
  }
  function moveBy(delta: number) {
    offset.current = normalize(offset.current + delta);
    paint();
  }

  // Un solo bucle de animación: avance automático e inercia tras soltar.
  useEffect(() => {
    const root = viewport.current;
    if (!root || !media.length) return;
    let frame = 0;
    let last = performance.now();
    let visible = true;
    offset.current = normalize(offset.current);
    paint();
    const step = (now: number) => {
      frame = requestAnimationFrame(step);
      const dt = Math.min(64, now - last);
      last = now;
      if (!visible || document.hidden || drag.current) return;
      if (Math.abs(velocity.current) > 0.02) {
        // Inercia: continúa el gesto y frena poco a poco.
        moveBy(velocity.current * dt);
        velocity.current *= Math.pow(0.92, dt / 16);
        touch();
        return;
      }
      velocity.current = 0;
      if (stopped || now - interactedAt.current < RESUME_AFTER_MS) return;
      moveBy((SPEED * dt) / 1000);
    };
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
    });
    observer.observe(root);
    frame = requestAnimationFrame(step);
    // Rueda o trackpad: solo el desplazamiento horizontal (o Mayús + rueda) mueve la galería;
    // el vertical sigue desplazando la página.
    const wheel = (event: WheelEvent) => {
      const delta =
        Math.abs(event.deltaX) > Math.abs(event.deltaY)
          ? event.deltaX
          : event.shiftKey
            ? event.deltaY
            : 0;
      if (!delta) return;
      event.preventDefault();
      velocity.current = 0;
      moveBy(delta);
      touch();
    };
    root.addEventListener('wheel', wheel, { passive: false });
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      root.removeEventListener('wheel', wheel);
    };
    // normalize/paint/moveBy solo leen refs y `stopped`, que ya es dependencia.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [media, stopped]);

  // Arrastre con dedo, ratón o lápiz. touch-action: pan-y deja el scroll vertical al navegador.
  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    velocity.current = 0;
    drag.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      start: offset.current,
      lastX: event.clientX,
      lastT: performance.now(),
      horizontal: null,
    };
    touch();
  }
  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const state = drag.current;
    const root = viewport.current;
    if (!state || !root || event.pointerId !== state.id) return;
    const dx = event.clientX - state.x;
    const dy = event.clientY - state.y;
    if (state.horizontal === null) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < DRAG_THRESHOLD) return;
      state.horizontal = Math.abs(dx) > Math.abs(dy);
      if (!state.horizontal) {
        // Gesto vertical: es scroll de la página, la galería no lo toma.
        drag.current = null;
        return;
      }
      root.setPointerCapture(state.id);
    }
    const now = performance.now();
    const elapsed = Math.max(1, now - state.lastT);
    velocity.current = -(event.clientX - state.lastX) / elapsed;
    state.lastX = event.clientX;
    state.lastT = now;
    offset.current = normalize(state.start - dx);
    paint();
    touch();
  }
  function endDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const state = drag.current;
    if (!state || event.pointerId !== state.id) return;
    drag.current = null;
    // Sin movimiento reciente no hay inercia (el dedo se detuvo antes de soltar).
    if (!state.horizontal || performance.now() - state.lastT > 80) velocity.current = 0;
    touch();
  }
  function step(direction: 1 | -1) {
    const figure = viewport.current?.querySelector('figure');
    velocity.current = 0;
    moveBy(direction * (figure?.clientWidth ?? 280));
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
      </div>
      <div
        className={`media-viewport ${reduced ? 'is-reduced' : ''}`}
        ref={viewport}
        tabIndex={0}
        aria-label="Galería de nuestro trabajo. Desliza para recorrerla."
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight') step(1);
          if (event.key === 'ArrowLeft') step(-1);
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDragStart={(event) => event.preventDefault()}
      >
        <div className="media-track" ref={track}>
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
