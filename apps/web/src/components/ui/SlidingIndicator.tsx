import { useLayoutEffect, useRef } from 'react';

/**
 * Indicador que se desliza hasta la opción activa de un grupo (navegación, filtros).
 * Mide la opción activa y la sigue al cambiar de selección, de tamaño o de línea.
 * Con movimiento reducido salta sin animación (lo resuelve el CSS).
 */
export function SlidingIndicator({
  selector,
  watch,
}: {
  /** Selector de la opción activa dentro del contenedor (el elemento padre). */
  selector: string;
  /** Cualquier valor que cambie con la selección. */
  watch: unknown;
}) {
  const indicator = useRef<HTMLSpanElement>(null);
  const placed = useRef(false);
  useLayoutEffect(() => {
    // El contenedor es el padre directo (su ref aún no está asignada en este efecto).
    const mark = indicator.current;
    const root = mark?.parentElement;
    if (!root || !mark) return;
    const place = () => {
      const target = root.querySelector<HTMLElement>(selector);
      if (!target || !target.offsetWidth) {
        mark.style.opacity = '0';
        placed.current = false;
        return;
      }
      // La primera vez aparece en su sitio, sin recorrer la barra desde la izquierda.
      mark.classList.toggle('is-instant', !placed.current);
      mark.style.opacity = '1';
      mark.style.width = `${target.offsetWidth}px`;
      mark.style.height = `${target.offsetHeight}px`;
      mark.style.transform = `translate(${target.offsetLeft}px, ${target.offsetTop}px)`;
      placed.current = true;
    };
    place();
    // También cada opción: la carga de la fuente cambia su ancho sin cambiar el contenedor.
    const observer = new ResizeObserver(place);
    observer.observe(root);
    for (const child of Array.from(root.children)) if (child !== mark) observer.observe(child);
    return () => observer.disconnect();
  }, [selector, watch]);
  return <span ref={indicator} className="sliding-indicator" aria-hidden="true" />;
}
