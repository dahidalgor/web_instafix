/**
 * Guion de "Cómo funciona": cada valor es una fracción (0–1) del recorrido de scroll
 * de la escena fija. Ajustar aquí el ritmo de toda la historia.
 */
export const timeline = {
  daySelected: 0.05,
  timeSelected: 0.1,
  confirmed: 0.15,
  assigned: 0.22,
  departs: 0.3,
  arrives: 0.7,
  service: 0.8,
  checks: [0.86, 0.91, 0.95],
} as const;

export const steps = [
  {
    label: 'Agenda',
    title: 'Agenda tu visita',
    text: 'Elige tu servicio, el día y la hora. Te confirmamos por WhatsApp.',
    start: 0,
    jump: 0.17,
  },
  {
    label: 'En camino',
    title: 'Vamos hacia ti',
    text: 'Compartes tu ubicación y un técnico de InstaFix sale en moto a tu domicilio.',
    start: timeline.assigned,
    jump: 0.48,
  },
  {
    label: 'Llegada',
    title: 'Llegamos a tu puerta',
    text: 'Sin cargar tu consola o computadora hasta un local.',
    start: 0.6,
    jump: 0.74,
  },
  {
    label: 'Servicio',
    title: 'Cuidamos tu equipo',
    text: 'Revisamos y hacemos el servicio ahí mismo, en tu domicilio.',
    start: timeline.service,
    jump: 0.97,
  },
] as const;

/** Instantes representativos para la versión estática (movimiento reducido). */
export const snapshots = [0.17, 0.5, 0.76, 1] as const;

export function stepAt(progress: number) {
  let index = 0;
  steps.forEach((step, i) => {
    if (progress >= step.start) index = i;
  });
  return index;
}
