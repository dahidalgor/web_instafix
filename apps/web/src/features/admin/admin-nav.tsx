import type { ReactNode } from 'react';

/**
 * Mapa de Administración: cuatro secciones con sus ventanas. Es la única fuente para la barra
 * lateral (escritorio), la barra inferior y la hoja «Más» (móvil) y el encabezado de cada ventana.
 */
export type AdminTab =
  | 'citas'
  | 'tecnico'
  | 'trabajos'
  | 'sorteo'
  | 'servicios'
  | 'categorias'
  | 'presentaciones'
  | 'garantias'
  | 'usuarios'
  | 'equipo'
  | 'numeros'
  | 'whatsapp'
  | 'correo'
  | 'notificaciones'
  | 'estadisticas';

export type AdminNavItem = {
  id: AdminTab;
  label: string;
  /** Nombre corto para la barra inferior del móvil. */
  short?: string;
  description: string;
  icon: ReactNode;
};
export type AdminNavGroup = { id: string; label: string; items: AdminNavItem[] };

const svg = (children: ReactNode) => (
  <svg
    viewBox="0 0 24 24"
    width="22"
    height="22"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    {children}
  </svg>
);

export const icons = {
  citas: svg(
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </>,
  ),
  tecnico: svg(
    <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z" />,
  ),
  trabajos: svg(
    <>
      <rect x="5" y="4" width="14" height="17" rx="2" />
      <path d="M9 3h6v3H9zM9 13l2 2 4-4" />
    </>,
  ),
  sorteo: svg(
    <>
      <rect x="3" y="8" width="18" height="4" rx="1" />
      <path d="M5 12v9h14v-9M12 8v13M12 8S10.5 3 8 4.5 9.5 8 12 8zM12 8s1.5-5 4-3.5S14.5 8 12 8z" />
    </>,
  ),
  servicios: svg(
    <>
      <path d="M3 12V4h8l10 10-8 8z" />
      <circle cx="7.5" cy="8.5" r="1.5" />
    </>,
  ),
  categorias: svg(<path d="M12 3 2 8l10 5 10-5zM2 13l10 5 10-5" />),
  presentaciones: svg(
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <circle cx="9" cy="10" r="2" />
      <path d="m21 16-5-5-8 8" />
    </>,
  ),
  garantias: svg(
    <>
      <path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z" />
      <path d="m9 12 2 2 4-4" />
    </>,
  ),
  usuarios: svg(
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3.5 6" />
    </>,
  ),
  equipo: svg(
    <>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <circle cx="12" cy="10" r="3" />
      <path d="M8 17a4 4 0 0 1 8 0" />
    </>,
  ),
  numeros: svg(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m5.6 5.6 12.8 12.8" />
    </>,
  ),
  whatsapp: svg(<path d="M21 12a8.5 8.5 0 0 1-12.5 7.5L3 21l1.5-5.2A8.5 8.5 0 1 1 21 12z" />),
  correo: svg(
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 7 9 6 9-6" />
    </>,
  ),
  notificaciones: svg(<path d="M6 16v-5a6 6 0 0 1 12 0v5l2 2H4zM10 21h4" />),
  estadisticas: svg(<path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />),
  mas: svg(
    <>
      <circle cx="5" cy="12" r="1.2" fill="currentColor" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" />
      <circle cx="19" cy="12" r="1.2" fill="currentColor" />
    </>,
  ),
  salir: svg(<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10" />),
} satisfies Record<string, ReactNode>;

export const adminGroups: AdminNavGroup[] = [
  {
    id: 'operacion',
    label: 'Operación',
    items: [
      {
        id: 'citas',
        label: 'Citas',
        description: 'Reservas de clientes: crear, reprogramar, vincular cuentas y eliminar.',
        icon: icons.citas,
      },
      {
        id: 'tecnico',
        label: 'Panel técnico',
        short: 'Técnico',
        description: 'Las visitas tal como las ve el técnico: confirmar, registrar y completar.',
        icon: icons.tecnico,
      },
      {
        id: 'trabajos',
        label: 'Trabajos',
        description: 'Registra un trabajo realizado y su garantía en la cuenta de un cliente.',
        icon: icons.trabajos,
      },
      {
        id: 'sorteo',
        label: 'Sorteo',
        description: 'Participantes del sorteo y corrección de participaciones por visita.',
        icon: icons.sorteo,
      },
    ],
  },
  {
    id: 'catalogo',
    label: 'Catálogo y web',
    items: [
      {
        id: 'servicios',
        label: 'Servicios',
        description: 'Servicios del catálogo público: precio, disponibilidad, fotos y garantía.',
        icon: icons.servicios,
      },
      {
        id: 'categorias',
        label: 'Categorías y equipos',
        short: 'Categorías',
        description: 'Organización del catálogo: categoría → equipo → servicio.',
        icon: icons.categorias,
      },
      {
        id: 'presentaciones',
        label: 'Presentaciones',
        description: 'Fotos y videos de trabajos que se muestran en la página de inicio.',
        icon: icons.presentaciones,
      },
      {
        id: 'garantias',
        label: 'Garantías',
        description: 'Texto de la política de garantía que ven los clientes.',
        icon: icons.garantias,
      },
    ],
  },
  {
    id: 'personas',
    label: 'Clientes y equipo',
    items: [
      {
        id: 'usuarios',
        label: 'Usuarios',
        description: 'Todas las cuentas: buscar, filtrar por tipo y eliminar.',
        icon: icons.usuarios,
      },
      {
        id: 'equipo',
        label: 'Equipo técnico',
        short: 'Equipo',
        description: 'Altas, datos de acceso y activación de los técnicos.',
        icon: icons.equipo,
      },
      {
        id: 'numeros',
        label: 'Números bloqueados',
        short: 'Números',
        description: 'Teléfonos que no pueden reservar ni recibir mensajes.',
        icon: icons.numeros,
      },
    ],
  },
  {
    id: 'sistema',
    label: 'Sistema',
    items: [
      {
        id: 'whatsapp',
        label: 'WhatsApp',
        description: 'Conexión con Bird, plantillas y resultado de cada mensaje.',
        icon: icons.whatsapp,
      },
      {
        id: 'correo',
        label: 'Correo',
        description: 'Estado del envío de correos y pruebas de entrega.',
        icon: icons.correo,
      },
      {
        id: 'notificaciones',
        label: 'Notificaciones',
        description: 'Avisos push en este dispositivo cuando llega una solicitud de cita.',
        icon: icons.notificaciones,
      },
      {
        id: 'estadisticas',
        label: 'Estadísticas',
        description: 'Visitas y tiempo de lectura de la web pública.',
        icon: icons.estadisticas,
      },
    ],
  },
];

export const adminItems = adminGroups.flatMap((group) =>
  group.items.map((item) => ({ ...item, group: group.label })),
);
export const findAdminItem = (id: AdminTab) => adminItems.find((item) => item.id === id)!;
export const isAdminTab = (value: unknown): value is AdminTab =>
  adminItems.some((item) => item.id === value);

/** Accesos fijos de la barra inferior del móvil; el resto está en «Más». */
export const mobilePrimary: AdminTab[] = ['citas', 'tecnico', 'servicios', 'usuarios'];
export const DEFAULT_ADMIN_TAB: AdminTab = 'citas';
