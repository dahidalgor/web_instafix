import { useEffect, type RefObject } from 'react';

const DOCKED = 'cta-docked';

/**
 * Un solo «Agendar» visible al terminar la historia: cuando el botón final entra en pantalla,
 * el botón lateral (escritorio) o el flotante (móvil) se oculta y el final aparece desplazándose
 * desde su posición (técnica FLIP). Al volver a subir, el lateral regresa. Con movimiento
 * reducido el cambio es inmediato, sin animación.
 */
export function useDockedCta(target: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const element = target.current;
    if (!element) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let docked = false;
    const visibleSource = () =>
      [...document.querySelectorAll<HTMLElement>('.story-cta, .mobile-booking')]
        .filter((node) => getComputedStyle(node).display !== 'none')
        .map((node) => node.getBoundingClientRect())
        .find((rect) => rect.width > 0 && rect.bottom > 0 && rect.top < window.innerHeight);
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting === docked) return;
        docked = entry.isIntersecting;
        if (!docked) {
          document.body.classList.remove(DOCKED);
          return;
        }
        const from = visibleSource();
        document.body.classList.add(DOCKED);
        if (!from || reduced) return;
        const to = element.getBoundingClientRect();
        const dx = from.left + from.width / 2 - (to.left + to.width / 2);
        const dy = from.top + from.height / 2 - (to.top + to.height / 2);
        element.animate(
          [
            { transform: `translate(${dx}px, ${dy}px)`, opacity: 1 },
            { transform: 'none', opacity: 1 },
          ],
          { duration: 560, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
        );
      },
      { threshold: 0.6 },
    );
    observer.observe(element);
    return () => {
      observer.disconnect();
      document.body.classList.remove(DOCKED);
    };
  }, [target]);
}
