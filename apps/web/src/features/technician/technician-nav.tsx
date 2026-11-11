import { shellIcons, staffSvg, type StaffNavGroup } from '../../components/staff/StaffShell';
import type { TechnicianTab } from './TechnicianPanel';

/** Ventanas del panel de técnicos: cuatro listas de visitas, horarios ocupados y ajustes. */
export type TechAppTab = 'hoy' | 'proximas' | 'pendientes' | 'historial' | 'horarios' | 'ajustes';

const svg = staffSvg;
export const techGroups: StaffNavGroup<TechAppTab>[] = [
  {
    id: 'visitas',
    label: 'Mis visitas',
    items: [
      {
        id: 'hoy',
        label: 'Hoy',
        description: 'Tus visitas de hoy y las anteriores que aún no completaste.',
        icon: svg(
          <>
            <rect x="3" y="5" width="18" height="16" rx="2" />
            <path d="M3 10h18M8 3v4M16 3v4M9 15l2 2 4-4" />
          </>,
        ),
      },
      {
        id: 'proximas',
        label: 'Próximas',
        description: 'Visitas confirmadas de los próximos días.',
        icon: svg(
          <>
            <rect x="3" y="5" width="18" height="16" rx="2" />
            <path d="M3 10h18M8 3v4M16 3v4M10 15h5M13 13l2 2-2 2" />
          </>,
        ),
      },
      {
        id: 'pendientes',
        label: 'Pendientes',
        description: 'Solicitudes de clientes que esperan que un técnico las confirme.',
        icon: svg(
          <>
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 2" />
          </>,
        ),
      },
      {
        id: 'historial',
        label: 'Historial',
        description: 'Visitas completadas, canceladas y anteriores.',
        icon: svg(<path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l4 2" />),
      },
    ],
  },
  {
    id: 'cuenta',
    label: 'Cuenta',
    items: [
      {
        id: 'horarios',
        label: 'Horarios',
        description: 'Las horas en que no puedes atender visitas (clases, otro trabajo…).',
        icon: svg(
          <>
            <rect x="3" y="5" width="18" height="16" rx="2" />
            <path d="M3 10h18M8 3v4M16 3v4M9 14l6 5M15 14l-6 5" />
          </>,
        ),
      },
      {
        id: 'ajustes',
        label: 'Ajustes',
        description:
          'Tus datos y seguridad, la apariencia y las notificaciones de este dispositivo.',
        icon: shellIcons.ajustes,
      },
    ],
  },
];

/** Barra inferior: las visitas; Horarios y Ajustes quedan en «Más». */
export const techPrimary: TechAppTab[] = ['hoy', 'proximas', 'pendientes', 'historial'];
const techTabs: TechAppTab[] = [...techPrimary, 'horarios', 'ajustes'];

export const techViews: Record<Exclude<TechAppTab, 'ajustes' | 'horarios'>, TechnicianTab> = {
  hoy: 'today',
  proximas: 'upcoming',
  pendientes: 'pending',
  historial: 'history',
};
export const isTechTab = (value: unknown): value is TechAppTab =>
  typeof value === 'string' && (techTabs as string[]).includes(value);
