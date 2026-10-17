import { timeline } from './story';

/** Coordenadas del "mundo" ilustrado: la cámara (viewBox) se desplaza sobre él. */
export const WORLD = { width: 1200, height: 620 } as const;
export const START_X = 150;
const END_X = 895;
const WHEEL_RADIUS = 24 * 0.92;

type Parts = {
  svg: SVGSVGElement;
  moto: SVGGElement;
  body: SVGGElement;
  wheels: SVGGElement[];
  speed: SVGGElement;
  beam: SVGPathElement;
  sky: SVGGElement;
  far: SVGGElement;
  mid: SVGGElement;
  route: SVGRectElement;
  routeGlow: SVGRectElement;
  routeAhead: SVGPathElement;
  eta: HTMLElement;
  view: { width: number; height: number; y: number };
  last: { progress: number; eta: string; flags: string };
};

const cache = new WeakMap<HTMLElement, Parts>();

function parts(scene: HTMLElement): Parts {
  let found = cache.get(scene);
  if (found) return found;
  const get = <T extends Element>(name: string) =>
    scene.querySelector(`[data-part="${name}"]`) as T;
  found = {
    svg: get('svg'),
    moto: get('moto-pos'),
    body: get('body'),
    wheels: [get('wheel-back'), get('wheel-front')],
    speed: get('speed'),
    beam: get('beam'),
    sky: get('sky'),
    far: get('far'),
    mid: get('mid'),
    route: get('route'),
    routeGlow: get('route-glow'),
    routeAhead: get('route-ahead'),
    eta: get('eta'),
    view: { width: WORLD.width, height: WORLD.height, y: 0 },
    last: { progress: -1, eta: '', flags: '' },
  };
  cache.set(scene, found);
  return found;
}

const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const range = (value: number, from: number, to: number) => clamp((value - from) / (to - from));
const easeInOut = (t: number) => 0.5 - Math.cos(Math.PI * t) / 2;

/**
 * Ajusta la "cámara" a la forma real del contenedor: en pantallas estrechas se recorta
 * el cielo para que la moto se vea grande, y la cámara acompaña el trayecto.
 */
export function measureScene(scene: HTMLElement) {
  const p = parts(scene);
  const { width, height } = scene.getBoundingClientRect();
  if (!width || !height) return;
  const aspect = width / height;
  // En pantallas estrechas se muestra al menos 480 unidades de calle (más cielo arriba).
  let viewHeight = width < 640 ? Math.max(520, 480 / aspect) : WORLD.height;
  let viewWidth = viewHeight * aspect;
  if (viewWidth > WORLD.width) {
    viewWidth = WORLD.width;
    viewHeight = viewWidth / aspect;
  }
  p.view = { width: viewWidth, height: viewHeight, y: WORLD.height - viewHeight };
  // Las tarjetas superpuestas escalan con la altura disponible.
  scene.style.setProperty('--scene-scale', clamp(height / 540, 0.56, 1).toFixed(3));
  p.last.progress = -1;
}

/** Pinta la escena para un progreso 0–1. Solo escribe transform/opacity/atributos SVG. */
export function paintScene(scene: HTMLElement, progress: number) {
  const p = parts(scene);
  if (Math.abs(progress - p.last.progress) < 0.0001) return;
  p.last.progress = progress;

  const travel = range(progress, timeline.departs, timeline.arrives);
  const eased = easeInOut(travel);
  const speed = Math.sin(Math.PI * travel);
  const x = START_X + eased * (END_X - START_X);

  // Cámara que sigue a la moto, con un poco de margen por delante.
  const { width, height, y } = p.view;
  const camera = clamp(x - width * 0.36, 0, WORLD.width - width);
  p.svg.setAttribute(
    'viewBox',
    `${camera.toFixed(1)} ${y.toFixed(1)} ${width.toFixed(1)} ${height.toFixed(1)}`,
  );
  // Paralaje: lo lejano se mueve menos que la calle.
  p.sky.setAttribute('transform', `translate(${(camera * 0.92).toFixed(1)} 0)`);
  p.far.setAttribute('transform', `translate(${(camera * 0.7).toFixed(1)} 0)`);
  p.mid.setAttribute('transform', `translate(${(camera * 0.4).toFixed(1)} 0)`);

  // La moto entra desde atrás al ser asignada y luego recorre la calle.
  const enter = easeInOut(range(progress, timeline.assigned, timeline.assigned + 0.05));
  const bob = Math.sin(x / 11) * 1.6 * speed;
  p.moto.setAttribute('transform', `translate(${(x - (1 - enter) * 60).toFixed(1)} 528)`);
  p.moto.style.opacity = enter.toFixed(3);
  p.body.setAttribute(
    'transform',
    `translate(0 ${bob.toFixed(2)}) rotate(${(-speed * 1.5).toFixed(2)} 0 -40)`,
  );
  const spin = (((x - START_X) / WHEEL_RADIUS) * 180) / Math.PI;
  for (const wheel of p.wheels) wheel.setAttribute('transform', `rotate(${spin.toFixed(1)})`);
  p.speed.setAttribute('opacity', (speed * 0.75).toFixed(3));
  p.speed.setAttribute('transform', `translate(${(-(1 - speed) * 30).toFixed(1)} 0)`);
  p.beam.setAttribute('opacity', (enter * (progress < timeline.arrives ? 1 : 0.4)).toFixed(3));

  // Ruta: lo recorrido en color de marca, lo pendiente punteado hasta tu casa.
  const drawn = Math.max(0, x - START_X);
  for (const rect of [p.route, p.routeGlow]) {
    rect.setAttribute('x', String(START_X));
    rect.setAttribute('width', drawn.toFixed(1));
  }
  p.routeAhead.setAttribute('d', `M${(x + 30).toFixed(1)} 544H1060`);
  p.routeAhead.setAttribute('opacity', (enter * (1 - range(travel, 0.92, 1))).toFixed(3));

  scene.style.setProperty('--travel', eased.toFixed(4));

  const minutes = String(Math.max(1, Math.ceil(14 * (1 - eased))));
  if (minutes !== p.last.eta) {
    p.last.eta = minutes;
    p.eta.textContent = minutes;
  }

  // Estados discretos: las transiciones CSS se encargan de animarlos.
  const flags: [string, boolean][] = [
    ['is-day', progress >= timeline.daySelected],
    ['is-time', progress >= timeline.timeSelected],
    ['is-confirmed', progress >= timeline.confirmed],
    ['is-assigned', progress >= timeline.assigned],
    ['is-moving', progress >= timeline.departs && progress < timeline.arrives],
    ['is-arrived', progress >= timeline.arrives],
    ['is-service', progress >= timeline.service],
    ['is-check-1', progress >= timeline.checks[0]],
    ['is-check-2', progress >= timeline.checks[1]],
    ['is-check-3', progress >= timeline.checks[2]],
  ];
  const key = flags.map(([, on]) => (on ? 1 : 0)).join('');
  if (key !== p.last.flags) {
    p.last.flags = key;
    for (const [name, on] of flags) scene.classList.toggle(name, on);
  }
}
