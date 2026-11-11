import type { AppointmentDateFilter, AppointmentStatusFilter } from '@instafix/contracts';

/** Etiquetas del organizador de citas. Los filtros se aplican en el servidor (por páginas). */
export type StatusFilter = AppointmentStatusFilter;
export type DateFilter = AppointmentDateFilter;
export const statusFilters: { id: StatusFilter; label: string }[] = [
  { id: 'active', label: 'Activas' },
  { id: 'PENDING_LOCATION', label: 'Pendientes' },
  { id: 'CONFIRMED', label: 'Confirmadas' },
  { id: 'COMPLETED', label: 'Completadas' },
  { id: 'CANCELLED', label: 'Canceladas' },
  { id: 'all', label: 'Todas' },
];
export const dateFilters: { id: DateFilter; label: string }[] = [
  { id: 'all', label: 'Cualquier fecha' },
  { id: 'today', label: 'Hoy' },
  { id: 'upcoming', label: 'Próximas' },
  { id: 'week', label: 'Próximos 7 días' },
  { id: 'past', label: 'Pasadas' },
  { id: 'custom', label: 'Rango de fechas' },
];
