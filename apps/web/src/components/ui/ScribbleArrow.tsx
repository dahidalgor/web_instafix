import { useEffect, useId, useRef } from 'react';

/**
 * Flecha de trazo grueso (estilo grafiti sobrio): cuerpo de marcador blanco con borde oscuro
 * fino y punta rellena, con bordes ligeramente irregulares. Se lee sobre fondo claro y oscuro.
 * Decorativa: oculta a lectores de pantalla; se «pinta» al entrar en pantalla (sin animación
 * con movimiento reducido).
 *
 * La flecha apunta hacia la izquierda; `className` la coloca y la gira con CSS.
 */
// Cuerpo curvo que termina en (20,118), justo donde empieza la punta.
const shaft = 'M200 18c-20 7-44 12-63 26-22 16-29 40-48 56-16 13-38 17-58 18-4 0-7 0-11 0';
// Punta rellena con la base cóncava, apuntando a la izquierda.
const head = 'M-2 119L32 92c-5 9-6 18-5 27 1 8 4 16 9 24z';

export function ScribbleArrow({ className = '' }: { className?: string }) {
  const ref = useRef<SVGSVGElement>(null);
  const rough = `rough-${useId().replace(/:/g, '')}`;
  useEffect(() => {
    const svg = ref.current;
    if (!svg) return;
    if (!('IntersectionObserver' in window)) return svg.classList.add('is-drawn');
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          svg.classList.add('is-drawn');
          observer.disconnect();
        }
      },
      { threshold: 0.4 },
    );
    observer.observe(svg);
    return () => observer.disconnect();
  }, []);
  return (
    <svg
      ref={ref}
      className={`scribble-arrow ${className}`}
      viewBox="-12 0 226 156"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        {/* Borde de marcador: deformación mínima, no un garabato. */}
        <filter id={rough} x="-10%" y="-10%" width="120%" height="120%">
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="7" />
          <feDisplacementMap in="SourceGraphic" scale="1.4" />
        </filter>
      </defs>
      <g filter={`url(#${rough})`}>
        <g className="scribble-outline">
          <path className="scribble-shaft" pathLength={1} d={shaft} />
          <path className="scribble-head" d={head} />
        </g>
        <g className="scribble-ink">
          <path className="scribble-shaft" pathLength={1} d={shaft} />
          <path className="scribble-head" d={head} />
        </g>
      </g>
    </svg>
  );
}
