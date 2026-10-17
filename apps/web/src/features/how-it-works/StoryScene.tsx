import { memo, type ReactElement } from 'react';
import { START_X, WORLD } from './paint-scene';

/*
 * Escena ilustrada de "Cómo funciona". Es decorativa (aria-hidden): el contenido
 * accesible vive en la lista de pasos. No recibe props para que React no la vuelva a
 * renderizar; paintScene() la actualiza directamente según el progreso del scroll.
 */

const far: [number, number, number][] = [
  [-40, 90, 250],
  [40, 70, 300],
  [100, 110, 220],
  [200, 60, 280],
  [250, 120, 240],
  [360, 80, 300],
  [430, 100, 200],
  [520, 70, 270],
  [580, 130, 230],
  [700, 90, 290],
  [780, 110, 210],
  [880, 80, 260],
  [950, 120, 230],
  [1060, 90, 280],
  [1140, 110, 200],
  [1240, 80, 260],
  [1310, 120, 230],
  [1420, 90, 280],
  [1500, 120, 220],
];
const mid: [number, number, number][] = [
  [-20, 130, 270],
  [150, 100, 320],
  [280, 150, 250],
  [470, 110, 300],
  [620, 140, 260],
  [800, 120, 310],
  [950, 160, 240],
  [1150, 110, 290],
  [1290, 150, 250],
  [1470, 130, 300],
];
const stars: [number, number, number][] = [
  [60, 70, 1.6],
  [180, 140, 1.2],
  [260, 50, 1.8],
  [400, 110, 1.3],
  [520, 40, 1.5],
  [610, 150, 1.1],
  [720, 80, 1.7],
  [860, 40, 1.2],
  [1000, 160, 1.4],
  [1120, 60, 1.6],
  [1230, 120, 1.2],
  [1360, 50, 1.5],
  [1480, 130, 1.3],
];
const GROUND = 446;

function windows(x: number, w: number, top: number) {
  const cells: ReactElement[] = [];
  for (let row = 0, y = top + 22; y < GROUND - 30; row++, y += 30) {
    for (let col = 0, cx = x + 16; cx < x + w - 22; col++, cx += 26) {
      const lit = (row * 7 + col * 3 + x) % 5 === 0;
      cells.push(
        <rect
          key={`${row}-${col}`}
          x={cx}
          y={y}
          width="10"
          height="14"
          rx="2"
          fill={lit ? '#ffd27a' : '#ffffff'}
          opacity={lit ? 0.45 : 0.06}
        />,
      );
    }
  }
  return cells;
}

function Lamp({ x }: { x: number }) {
  return (
    <g>
      <path
        d={`M${x + 26} 312 L${x - 30} ${GROUND + 40} L${x + 90} ${GROUND + 40} Z`}
        fill="url(#lamp-light)"
      />
      <path
        d={`M${x} ${GROUND} V300 q0 -12 14 -12 h12`}
        stroke="#3c3360"
        strokeWidth="6"
        fill="none"
        strokeLinecap="round"
      />
      <rect x={x + 16} y={284} width="22" height="9" rx="4" fill="#4a3f70" />
      <rect x={x + 19} y={292} width="16" height="4" rx="2" fill="#ffe7a8" />
    </g>
  );
}

function Tree({ x }: { x: number }) {
  return (
    <g>
      <rect x={x - 4} y={GROUND - 46} width="8" height="46" rx="3" fill="#2b2449" />
      <circle cx={x} cy={GROUND - 66} r="30" fill="#2a2f5a" />
      <circle cx={x - 18} cy={GROUND - 52} r="18" fill="#2a2f5a" />
      <circle cx={x + 18} cy={GROUND - 50} r="20" fill="#252a52" />
    </g>
  );
}

/** Logo de la marca en la caja de herramientas: "i↗". */
function BoxLogo({ x, y, size }: { x: number; y: number; size: number }) {
  return (
    <text
      x={x}
      y={y}
      fill="#fff"
      fontFamily="Manrope, sans-serif"
      fontWeight="800"
      fontSize={size}
      textAnchor="middle"
    >
      i↗
    </text>
  );
}

function Wheel({ cx, name }: { cx: number; name: string }) {
  return (
    <g transform={`translate(${cx} -24)`}>
      <g data-part={name}>
        <circle r="24" fill="#14152f" stroke="#3a3558" strokeWidth="3" />
        <circle r="13" fill="#d8d0e6" />
        <path
          d="M0 -13V13M-11.3 -6.5 11.3 6.5M-11.3 6.5 11.3 -6.5"
          stroke="#7d7397"
          strokeWidth="2.4"
        />
        <circle r="4" fill="#14152f" />
      </g>
    </g>
  );
}

/** Técnico de InstaFix en scooter, de perfil y mirando a la derecha. Origen: suelo, entre ruedas. */
function Moto() {
  return (
    <g data-part="moto" className="scene-moto">
      <g data-part="speed" opacity="0" stroke="#fff" strokeWidth="3.5" strokeLinecap="round">
        <path d="M-200 -150h46M-226 -104h64M-196 -58h40" />
      </g>
      <path data-part="beam" d="M50 -104 L330 -56 L330 14 Z" fill="url(#beam)" opacity="0" />
      <g className="moto-tag">
        <rect x="-86" y="-262" width="172" height="34" rx="17" fill="#fff" />
        <circle cx="-64" cy="-245" r="6" fill="#22a06b" />
        <text
          x="-50"
          y="-239"
          fontSize="15"
          fontWeight="700"
          fill="#14152f"
          fontFamily="DM Sans, sans-serif"
        >
          Técnico asignado
        </text>
      </g>
      <Wheel cx={-58} name="wheel-back" />
      <Wheel cx={64} name="wheel-front" />
      <g data-part="body">
        {/* Horquilla y guardabarros */}
        <path d="M42 -108 L64 -26" stroke="#8b82a6" strokeWidth="6" strokeLinecap="round" />
        <path d="M40 -52 Q64 -64 88 -46 L84 -40 Q64 -54 44 -44 Z" fill="#f6eff9" />
        {/* Carrocería */}
        <path
          d="M-106 -40 Q-110 -86 -66 -88 L-8 -88 Q8 -88 4 -68 L-2 -46 L-28 -46 Q-32 -60 -58 -60 Q-82 -60 -88 -40 Z"
          fill="#f6eff9"
        />
        <path
          d="M-98 -64 Q-80 -74 -40 -74 L-6 -74"
          stroke="#d0247f"
          strokeWidth="7"
          fill="none"
          strokeLinecap="round"
        />
        <rect x="-36" y="-50" width="72" height="13" rx="6" fill="#f6eff9" />
        <path d="M22 -46 L36 -46 Q50 -82 46 -114 L34 -114 Q32 -80 22 -46 Z" fill="#f6eff9" />
        <path
          d="M37 -56 Q46 -84 43 -108"
          stroke="#d0247f"
          strokeWidth="5"
          fill="none"
          strokeLinecap="round"
        />
        <rect x="-100" y="-34" width="26" height="8" rx="4" fill="#6f6688" />
        {/* Caja de herramientas con la marca */}
        <path d="M-112 -96 H-64" stroke="#8b82a6" strokeWidth="4" strokeLinecap="round" />
        <rect x="-122" y="-142" width="56" height="46" rx="9" fill="#d0247f" />
        <rect x="-122" y="-130" width="56" height="4" fill="#a00d68" />
        <BoxLogo x={-94} y={-104} size={20} />
        {/* Asiento */}
        <path d="M-84 -90 Q-82 -100 -62 -100 L-14 -98 Q-4 -97 -6 -88 Z" fill="#1d1a33" />
        {/* Técnico */}
        <path d="M-46 -100 L2 -96" stroke="#6b5c9e" strokeWidth="17" strokeLinecap="round" />
        <path d="M2 -96 L16 -56" stroke="#6b5c9e" strokeWidth="14" strokeLinecap="round" />
        <rect x="6" y="-58" width="26" height="11" rx="5" fill="#14152f" />
        <path d="M-64 -96 Q-70 -142 -44 -168 L-22 -168 Q-6 -150 -20 -98 Z" fill="#c2187a" />
        <path
          d="M-60 -128 Q-40 -132 -16 -126"
          stroke="#fff"
          strokeWidth="4"
          fill="none"
          opacity="0.8"
        />
        <path
          d="M-34 -156 L-2 -132 L32 -118"
          stroke="#c2187a"
          strokeWidth="12"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="33" cy="-117" r="7" fill="#1d1a33" />
        {/* Manillar y faro */}
        <path d="M28 -118 L54 -121" stroke="#1d1a33" strokeWidth="6" strokeLinecap="round" />
        <circle cx="50" cy="-104" r="7" fill="#ffe7a8" />
        {/* Casco */}
        <circle cx="-30" cy="-186" r="21" fill="#fff" />
        <path
          d="M-50 -190 Q-30 -214 -10 -192"
          stroke="#d0247f"
          strokeWidth="6"
          fill="none"
          strokeLinecap="round"
        />
        <path d="M-20 -194 Q-6 -192 -10 -176 L-26 -176 Q-28 -188 -20 -194 Z" fill="#1d1a33" />
      </g>
    </g>
  );
}

function House() {
  return (
    <g className="scene-house">
      <rect x="1110" y="244" width="18" height="44" fill="#7b1453" />
      <rect x="975" y="300" width="170" height={GROUND - 300} fill="#f3ecf8" />
      <path d="M953 308 L1060 230 L1167 308 Z" fill="#a00d68" />
      <path
        d="M953 308 L1060 230 L1167 308"
        stroke="#7b1453"
        strokeWidth="8"
        fill="none"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <rect
        className="house-glow"
        x="1048"
        y="384"
        width="26"
        height={GROUND - 384}
        fill="#ffd27a"
      />
      <rect
        className="house-door"
        x="1046"
        y="382"
        width="30"
        height={GROUND - 382}
        rx="3"
        fill="#522047"
      />
      <rect className="house-window" x="996" y="330" width="40" height="38" rx="5" />
      <rect className="house-window" x="1086" y="330" width="40" height="38" rx="5" />
      <path d="M1016 330v38M996 349h40M1106 330v38M1086 349h40" stroke="#f3ecf8" strokeWidth="3" />
      <rect x="1038" y={GROUND - 2} width="46" height="6" rx="2" fill="#d8cde6" />
      <circle cx="986" cy={GROUND - 8} r="14" fill="#2f6e5c" />
      <circle cx="1136" cy={GROUND - 8} r="14" fill="#2f6e5c" />
      <g className="house-pin">
        <g className="pin-label pin-home">
          <rect x="1016" y="128" width="88" height="32" rx="16" fill="#fff" />
          <text
            x="1060"
            y="149"
            textAnchor="middle"
            fontSize="15"
            fontWeight="700"
            fill="#14152f"
            fontFamily="DM Sans, sans-serif"
          >
            Tu casa
          </text>
        </g>
        <g className="pin-label pin-arrived">
          <rect x="1000" y="128" width="120" height="32" rx="16" fill="#22a06b" />
          <text
            x="1060"
            y="149"
            textAnchor="middle"
            fontSize="15"
            fontWeight="700"
            fill="#fff"
            fontFamily="DM Sans, sans-serif"
          >
            ✓ Llegamos
          </text>
        </g>
        <g className="pin-shape">
          <path
            d="M1060 226 C1044 208 1038 198 1038 186 A22 22 0 1 1 1082 186 C1082 198 1076 208 1060 226Z"
            fill="#d0247f"
            stroke="#fff"
            strokeWidth="3"
          />
          <circle cx="1060" cy="186" r="8" fill="#fff" />
        </g>
      </g>
    </g>
  );
}

function Svg() {
  return (
    <svg
      className="scene-world"
      data-part="svg"
      viewBox={`0 0 ${WORLD.width} ${WORLD.height}`}
      preserveAspectRatio="xMidYMax slice"
    >
      <defs>
        <linearGradient id="beam" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="#fff3c4" stopOpacity="0.7" />
          <stop offset="1" stopColor="#fff3c4" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="lamp-light" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#ffe7a8" stopOpacity="0.22" />
          <stop offset="1" stopColor="#ffe7a8" stopOpacity="0" />
        </linearGradient>
        <radialGradient id="moon">
          <stop offset="0" stopColor="#ffd5ee" stopOpacity="0.5" />
          <stop offset="1" stopColor="#ffd5ee" stopOpacity="0" />
        </radialGradient>
      </defs>
      <g data-part="sky">
        <circle cx="900" cy="120" r="150" fill="url(#moon)" />
        <circle cx="900" cy="120" r="34" fill="#ffe3f3" opacity="0.85" />
        {stars.map(([x, y, r]) => (
          <circle key={`${x}-${y}`} cx={x} cy={y} r={r} fill="#fff" opacity="0.55" />
        ))}
      </g>
      <g data-part="far">
        {far.map(([x, w, top]) => (
          <rect
            key={x}
            x={x}
            y={top}
            width={w}
            height={GROUND - top}
            fill="#ffffff"
            opacity="0.05"
          />
        ))}
      </g>
      <g data-part="mid">
        {mid.map(([x, w, top]) => (
          <g key={x}>
            <rect x={x} y={top} width={w} height={GROUND - top} rx="4" fill="#1e1a40" />
            {windows(x, w, top)}
          </g>
        ))}
      </g>
      {/* Calle */}
      <rect x="-200" y={GROUND - 12} width={WORLD.width + 400} height="14" fill="#2a2148" />
      <rect x="-200" y={GROUND} width={WORLD.width + 400} height="114" fill="#0d0f24" />
      <path
        d={`M-200 503H${WORLD.width + 200}`}
        stroke="#fff"
        strokeOpacity="0.16"
        strokeWidth="4"
        strokeDasharray="34 30"
      />
      <rect x="-200" y="560" width={WORLD.width + 400} height="12" fill="#3a2f55" />
      <rect x="-200" y="572" width={WORLD.width + 400} height="60" fill="#1c1834" />
      <Lamp x={330} />
      <Tree x={540} />
      <Lamp x={760} />
      <House />
      {/* Ruta: lo recorrido se dibuja detrás de la moto; lo pendiente queda punteado. */}
      <path
        data-part="route-ahead"
        d="M0 544H1060"
        stroke="#fff"
        strokeOpacity="0.35"
        strokeWidth="4"
        strokeDasharray="2 12"
        strokeLinecap="round"
      />
      <rect
        data-part="route-glow"
        x="0"
        y="538"
        height="12"
        width="0"
        rx="6"
        fill="#d0247f"
        opacity="0.3"
      />
      <rect data-part="route" x="0" y="541" height="6" width="0" rx="3" fill="#f05aa8" />
      <circle
        className="route-start"
        cx={START_X}
        cy="544"
        r="8"
        fill="#fff"
        stroke="#d0247f"
        strokeWidth="4"
      />
      <g data-part="moto-pos">
        <g transform="scale(0.92)">
          <Moto />
        </g>
      </g>
    </svg>
  );
}

function Check() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path
        d="m5 10.5 3.2 3.2L15 7"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ServiceArt() {
  return (
    <svg viewBox="0 0 360 220" className="service-art">
      <ellipse cx="190" cy="206" rx="170" ry="10" fill="currentColor" opacity="0.08" />
      {/* Caja de herramientas: la misma que viaja en la moto */}
      <rect x="22" y="160" width="62" height="46" rx="9" fill="#d0247f" />
      <rect x="22" y="172" width="62" height="4" fill="#a00d68" />
      <path d="M40 160v-8h26v8" stroke="#a00d68" strokeWidth="5" fill="none" />
      <BoxLogo x={53} y={200} size={20} />
      {/* Mesa */}
      <rect x="150" y="140" width="196" height="10" rx="4" fill="#cfc3de" />
      <path d="M164 150v56M332 150v56" stroke="#cfc3de" strokeWidth="7" strokeLinecap="round" />
      {/* Consola abierta */}
      <rect
        x="178"
        y="104"
        width="78"
        height="36"
        rx="9"
        fill="#fff"
        stroke="#2a2346"
        strokeWidth="3"
      />
      <rect x="190" y="114" width="54" height="16" rx="4" fill="#2a2346" />
      <path
        className="console-led"
        d="M196 122h42"
        stroke="#f05aa8"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <path
        d="M180 104 L170 84 L246 84 L254 104"
        fill="#efe9f5"
        stroke="#2a2346"
        strokeWidth="3"
        strokeLinejoin="round"
      />
      {/* Portátil con diagnóstico */}
      <rect x="270" y="78" width="62" height="56" rx="6" fill="#111630" />
      <path d="M262 136h78" stroke="#2a2346" strokeWidth="6" strokeLinecap="round" />
      <path
        d="M281 96h26M281 106h36M281 116h18"
        stroke="#fff"
        strokeOpacity="0.35"
        strokeWidth="4"
        strokeLinecap="round"
        className="laptop-lines"
      />
      <path
        className="laptop-check"
        d="m286 106 10 10 20-22"
        stroke="#4ade9a"
        strokeWidth="6"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Técnico sentado trabajando */}
      <rect x="92" y="158" width="44" height="10" rx="4" fill="#3d3260" />
      <path d="M100 168v38M128 168v38" stroke="#3d3260" strokeWidth="6" strokeLinecap="round" />
      <path
        d="M120 156 L156 158 L160 200"
        stroke="#3d3260"
        strokeWidth="15"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M96 160 Q90 112 116 90 L138 92 Q150 120 136 160 Z" fill="#c2187a" />
      <path d="M100 128 Q118 124 142 130" stroke="#fff" strokeWidth="4" fill="none" opacity="0.8" />
      <g className="tech-arm">
        <path
          d="M128 102 L160 122 L184 112"
          stroke="#c2187a"
          strokeWidth="11"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="186" cy="111" r="6" fill="#8a5a44" />
        <path d="M188 110 L204 102" stroke="#7d7397" strokeWidth="3.5" strokeLinecap="round" />
        <path d="M184 112 L192 108" stroke="#d0247f" strokeWidth="6" strokeLinecap="round" />
      </g>
      <circle cx="126" cy="70" r="18" fill="#8a5a44" />
      <path d="M108 66 Q110 46 128 48 Q146 50 144 66 Q132 58 108 66 Z" fill="#a00d68" />
      <path d="M140 60 L156 64" stroke="#a00d68" strokeWidth="5" strokeLinecap="round" />
      <g className="sparkles" fill="#f5b800">
        <path d="M262 62l3 7 7 3-7 3-3 7-3-7-7-3 7-3z" />
        <path d="M168 66l2 5 5 2-5 2-2 5-2-5-5-2 5-2z" />
      </g>
    </svg>
  );
}

const days = [
  ['Lun', '13'],
  ['Mar', '14'],
  ['Mié', '15'],
  ['Jue', '16'],
  ['Vie', '17'],
];

export const StoryScene = memo(function StoryScene() {
  return (
    <div className="scene-inner" aria-hidden="true">
      <Svg />
      <div className="scene-dim" />

      <div className="scene-card scene-booking">
        <div className="sb-head">
          <span className="sb-logo">i↗</span>
          <b>InstaFix</b>
          <span>Agenda</span>
        </div>
        <p className="sb-label">Servicio</p>
        <div className="sb-service">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M7 8h10a4 4 0 0 1 4 4v3a2 2 0 0 1-3.6 1.2L16 14H8l-1.4 2.2A2 2 0 0 1 3 15v-3a4 4 0 0 1 4-4Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinejoin="round"
            />
            <path
              d="M8 10.5v3M6.5 12h3"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
            <circle cx="16" cy="11" r="1" fill="currentColor" />
            <circle cx="17.5" cy="13" r="1" fill="currentColor" />
          </svg>
          Mantenimiento de consola
        </div>
        <p className="sb-label">Elige el día</p>
        <div className="sb-days">
          {days.map(([day, number], index) => (
            <span key={number} className={index === 3 ? 'is-pick' : undefined}>
              <small>{day}</small>
              {number}
            </span>
          ))}
        </div>
        <p className="sb-label">Horario</p>
        <div className="sb-times">
          <span>10:00</span>
          <span>13:00</span>
          <span className="is-pick">16:00</span>
        </div>
        <div className="sb-confirm">
          <span className="sb-confirm-idle">Confirmar visita</span>
          <span className="sb-confirm-done">
            <Check /> Cita confirmada
          </span>
        </div>
      </div>

      <div className="scene-card scene-tracker">
        <div className="st-row">
          <span className="st-avatar">
            <svg viewBox="0 0 32 32" aria-hidden="true">
              <circle cx="9" cy="23" r="4" fill="none" stroke="currentColor" strokeWidth="2.2" />
              <circle cx="24" cy="23" r="4" fill="none" stroke="currentColor" strokeWidth="2.2" />
              <path
                d="M9 23h9l3-9h-4M21 14l3 9M5 15h7l3 4"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <div className="st-text">
            <span className="st-state st-assigned">
              <b>Técnico asignado</b>
              <small>Ubicación recibida por WhatsApp</small>
            </span>
            <span className="st-state st-moving">
              <b>En camino a tu domicilio</b>
              <small>
                Llega en <span data-part="eta" /> min
              </small>
            </span>
            <span className="st-state st-arrived">
              <b>Tu técnico llegó</b>
              <small>Está en la puerta de tu casa</small>
            </span>
          </div>
          <span className="st-check">
            <Check />
          </span>
        </div>
        <div className="st-route">
          <span className="st-start" />
          <span className="st-line">
            <i className="st-fill" />
            <span className="st-dot-track">
              <i className="st-dot" />
            </span>
          </span>
          <svg className="st-home" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 11 12 4l8 7v9H4z" fill="currentColor" />
            <rect x="10" y="14" width="4" height="6" fill="#fff" />
          </svg>
        </div>
        <div className="st-labels">
          <span>Técnico</span>
          <span>Tu casa</span>
        </div>
      </div>

      <div className="scene-card scene-service">
        <p className="ss-eyebrow">En tu domicilio</p>
        <ServiceArt />
        <ul className="ss-checks">
          <li>
            <Check /> Diagnóstico
          </li>
          <li>
            <Check /> Mantenimiento o reparación
          </li>
          <li>
            <Check /> Pruebas finales
          </li>
        </ul>
      </div>
    </div>
  );
});
