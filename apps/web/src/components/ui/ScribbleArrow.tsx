import { useEffect, useId, useRef } from 'react';

/**
 * Flecha de trazo grueso (estilo grafiti sobrio): cuerpo de marcador con borde fino y punta
 * rellena, con bordes ligeramente irregulares. Los colores salen de tokens del tema (claro y
 * oscuro). Decorativa: oculta a lectores de pantalla; se «pinta» al entrar en pantalla (sin
 * animación con movimiento reducido).
 *
 * direction="left": horizontal, para escritorio (className la coloca y la gira con CSS).
 * direction="down": vertical, para el teléfono; va en el flujo del documento, entre bloques,
 * así nunca tapa contenido ni provoca desbordes.
 */
const shapes = {
  // Cuerpo curvo que termina en (20,118), justo donde empieza la punta (que apunta a la izquierda).
  left: {
    viewBox: '-12 0 226 156',
    shaft: 'M200 18c-20 7-44 12-63 26-22 16-29 40-48 56-16 13-38 17-58 18-4 0-7 0-11 0',
    tip: { x: -2, y: 119, rotate: 0 },
  },
  // Trazo en S que baja siguiendo los pasos; la punta apunta hacia abajo con vértice en (56,194).
  down: {
    viewBox: '0 -6 120 216',
    shaft: 'M74 6c-20 22-38 40-33 66 5 25 34 38 30 66-2 14-8 24-16 34',
    tip: { x: 56, y: 194, rotate: -90 },
  },
} as const;
// Punta rellena con la base cóncava, con el vértice en el origen y apuntando a la izquierda.
const head = 'M0 0L34 -27c-5 9-6 18-5 27 1 8 4 16 9 24z';

export function ScribbleArrow({
  className = '',
  direction = 'left',
}: {
  className?: string;
  direction?: keyof typeof shapes;
}) {
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
  const shape = shapes[direction];
  const [x, y, width, height] = shape.viewBox.split(' ').map(Number);
  const tip = `translate(${shape.tip.x} ${shape.tip.y}) rotate(${shape.tip.rotate})`;
  const layer = (name: string) => (
    <g className={name}>
      <path className="scribble-shaft" pathLength={1} d={shape.shaft} />
      <g transform={tip}>
        <path className="scribble-head" d={head} />
      </g>
    </g>
  );
  return (
    <svg
      ref={ref}
      className={`scribble-arrow scribble-${direction} ${className}`}
      viewBox={shape.viewBox}
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        {/* Región del filtro en coordenadas del dibujo: incluye el grosor del trazo (con la
            caja del contorno, el trazo grueso se recortaba en los bordes). */}
        <filter
          id={rough}
          filterUnits="userSpaceOnUse"
          x={x - 20}
          y={y - 20}
          width={width + 40}
          height={height + 40}
        >
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="7" />
          <feDisplacementMap in="SourceGraphic" scale="1.4" />
        </filter>
      </defs>
      <g filter={`url(#${rough})`}>
        {layer('scribble-outline')}
        {layer('scribble-ink')}
      </g>
    </svg>
  );
}
