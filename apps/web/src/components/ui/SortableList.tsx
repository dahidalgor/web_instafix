import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';

/** Mueve el elemento de `from` a `to` (índices) y devuelve la lista nueva. */
export function moveItem<T>(list: T[], from: number, to: number) {
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/**
 * Posición final al soltar: cuántos de los demás elementos tienen su centro por encima del
 * centro del elemento arrastrado. `mids` son los centros de todos (en el mismo sistema de
 * coordenadas que `center`).
 */
export function dropIndex(mids: number[], dragged: number, center: number) {
  let index = 0;
  mids.forEach((mid, i) => {
    if (i !== dragged && mid < center) index++;
  });
  return index;
}

type Scroller = Window | HTMLElement;
function scrollParent(element: HTMLElement | null): Scroller {
  for (let node = element?.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight)
      return node;
  }
  return window;
}
const scrollTop = (s: Scroller) => (s instanceof Window ? window.scrollY : s.scrollTop);
const viewport = (s: Scroller) =>
  s instanceof Window
    ? { top: 0, bottom: window.innerHeight }
    : (({ top, bottom }) => ({ top, bottom }))(s.getBoundingClientRect());

type Drag = {
  id: string;
  index: number;
  startY: number;
  lastY: number;
  startScroll: number;
  scroller: Scroller;
  /** Centros de cada fila en coordenadas de documento/contenido (fijos durante el arrastre). */
  mids: number[];
  top: number;
  height: number;
  /** Lo que se desplazan las demás filas: alto de la fila arrastrada + separación. */
  shift: number;
  frame: number;
};

/**
 * Lista reordenable arrastrando un asa. Funciona con ratón, dedo (iPhone/Android: eventos
 * pointer y `touch-action: none` en el asa) y teclado (flechas ↑ ↓ sobre el asa). Mientras se
 * arrastra, la lista hace scroll sola cerca de los bordes. Al soltar llama a `onReorder` con
 * los ids en el orden nuevo; quien la usa guarda el cambio.
 */
export function SortableList<T>({
  items,
  getId,
  getLabel,
  onReorder,
  renderItem,
  disabled = false,
  className = '',
}: {
  items: T[];
  getId: (item: T) => string;
  /** Nombre para lectores de pantalla («Mover PS5»). */
  getLabel: (item: T) => string;
  onReorder: (ids: string[]) => void;
  /** Contenido de la fila; `handle` es el asa para arrastrar. */
  renderItem: (item: T, handle: ReactNode, dragging: boolean) => ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  const rows = useRef(new Map<string, HTMLLIElement>());
  const handles = useRef(new Map<string, HTMLButtonElement>());
  const drag = useRef<Drag | null>(null);
  const [dragging, setDragging] = useState<{ id: string; offset: number; target: number } | null>(
    null,
  );
  const [announcement, setAnnouncement] = useState('');
  const refocus = useRef<string | null>(null);
  const ids = items.map(getId);

  // Tras mover con el teclado, el foco sigue en el asa del elemento movido.
  useEffect(() => {
    if (!refocus.current) return;
    handles.current.get(refocus.current)?.focus();
    refocus.current = null;
  });
  useEffect(() => () => cancelAnimationFrame(drag.current?.frame ?? 0), []);

  const measure = (d: Drag) => {
    const offset = d.lastY - d.startY + (scrollTop(d.scroller) - d.startScroll);
    return { offset, target: dropIndex(d.mids, d.index, d.top + d.height / 2 + offset) };
  };
  function update() {
    const d = drag.current;
    if (d) setDragging({ id: d.id, ...measure(d) });
  }
  /** Scroll automático cerca de los bordes mientras se arrastra. */
  function autoScroll() {
    const d = drag.current;
    if (!d) return;
    const { top, bottom } = viewport(d.scroller);
    const edge = 56;
    const speed =
      d.lastY < top + edge
        ? -Math.ceil((top + edge - d.lastY) / 4)
        : d.lastY > bottom - edge
          ? Math.ceil((d.lastY - (bottom - edge)) / 4)
          : 0;
    if (speed) {
      if (d.scroller instanceof Window) window.scrollBy(0, speed);
      else d.scroller.scrollTop += speed;
      update();
    }
    d.frame = requestAnimationFrame(autoScroll);
  }

  function start(event: PointerEvent<HTMLButtonElement>, index: number) {
    if (disabled || event.button !== 0 || items.length < 2) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const id = ids[index];
    const scroller = scrollParent(rows.current.get(id) ?? null);
    const scroll = scrollTop(scroller);
    const rects = ids.map((rowId) => rows.current.get(rowId)!.getBoundingClientRect());
    const gap = rects.length > 1 ? Math.max(0, rects[1].top - rects[0].bottom) : 0;
    drag.current = {
      id,
      index,
      startY: event.clientY,
      lastY: event.clientY,
      startScroll: scroll,
      scroller,
      mids: rects.map((r) => r.top + scroll + r.height / 2),
      top: rects[index].top + scroll,
      height: rects[index].height,
      shift: rects[index].height + gap,
      frame: 0,
    };
    document.body.classList.add('is-sorting');
    setDragging({ id, offset: 0, target: index });
    drag.current.frame = requestAnimationFrame(autoScroll);
  }
  function move(event: PointerEvent<HTMLButtonElement>) {
    if (!drag.current) return;
    drag.current.lastY = event.clientY;
    update();
  }
  function end(cancelled: boolean) {
    const d = drag.current;
    if (!d) return;
    cancelAnimationFrame(d.frame);
    drag.current = null;
    document.body.classList.remove('is-sorting');
    const { target } = measure(d);
    setDragging(null);
    if (!cancelled && target !== d.index) {
      onReorder(moveItem(ids, d.index, target));
      setAnnouncement(`${getLabel(items[d.index])}: posición ${target + 1} de ${items.length}.`);
    }
  }
  function keyboard(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (disabled) return;
    const to =
      event.key === 'ArrowUp'
        ? index - 1
        : event.key === 'ArrowDown'
          ? index + 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? items.length - 1
              : null;
    if (to === null) return;
    event.preventDefault();
    if (to < 0 || to >= items.length || to === index) return;
    refocus.current = ids[index];
    onReorder(moveItem(ids, index, to));
    setAnnouncement(`${getLabel(items[index])}: posición ${to + 1} de ${items.length}.`);
  }

  const shiftOf = (i: number) => {
    const d = drag.current;
    if (!dragging || !d || ids[i] === dragging.id) return 0;
    const { target } = dragging;
    if (d.index < target && i > d.index && i <= target) return -d.shift;
    if (target < d.index && i >= target && i < d.index) return d.shift;
    return 0;
  };

  return (
    <>
      <ul className={`sortable ${className}`}>
        {items.map((item, index) => {
          const id = getId(item);
          const active = dragging?.id === id;
          const y = active ? dragging.offset : shiftOf(index);
          const handle = (
            <button
              type="button"
              className="sort-handle"
              ref={(node) => {
                if (node) handles.current.set(id, node);
                else handles.current.delete(id);
              }}
              aria-label={`Mover ${getLabel(item)} (flechas arriba y abajo)`}
              title="Arrastra para ordenar"
              disabled={disabled || items.length < 2}
              onPointerDown={(event) => start(event, index)}
              onPointerMove={move}
              onPointerUp={() => end(false)}
              onPointerCancel={() => end(true)}
              onKeyDown={(event) => keyboard(event, index)}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <circle cx="9" cy="6" r="1.6" />
                <circle cx="15" cy="6" r="1.6" />
                <circle cx="9" cy="12" r="1.6" />
                <circle cx="15" cy="12" r="1.6" />
                <circle cx="9" cy="18" r="1.6" />
                <circle cx="15" cy="18" r="1.6" />
              </svg>
            </button>
          );
          return (
            <li
              key={id}
              ref={(node) => {
                if (node) rows.current.set(id, node);
                else rows.current.delete(id);
              }}
              className={`sortable-item${active ? ' is-dragging' : ''}${dragging ? ' is-shifting' : ''}`}
              style={y ? { transform: `translateY(${y}px)` } : undefined}
            >
              {renderItem(item, handle, active)}
            </li>
          );
        })}
      </ul>
      <p className="visually-hidden" aria-live="polite">
        {announcement}
      </p>
    </>
  );
}
