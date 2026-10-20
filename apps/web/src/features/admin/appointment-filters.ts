import { visitDayKey } from '../../components/appointments/AppointmentCard';

export type StatusFilter =
  'active' | 'PENDING_LOCATION' | 'CONFIRMED' | 'COMPLETED' | 'CANCELLED' | 'all';
export type DateFilter = 'all' | 'today' | 'upcoming' | 'week' | 'past' | 'custom';
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

type Filterable = {
  status: string;
  startsAt: string;
  title: string;
  contactName?: string;
  contactPhone?: string;
  user?: { name: string; phone: string } | null;
};
const plain = (value: string) =>
  value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('es');
const digits = (value: string) => value.replace(/\D/g, '');

export function matchesStatus(item: { status: string }, filter: StatusFilter) {
  if (filter === 'all') return true;
  if (filter === 'active')
    return ['PENDING_LOCATION', 'CONFIRMED', 'IN_PROGRESS'].includes(item.status);
  if (filter === 'CONFIRMED') return item.status === 'CONFIRMED' || item.status === 'IN_PROGRESS';
  return item.status === filter;
}

/** Texto: nombre, solicitud o teléfono (ignora tildes, espacios y prefijos como +593 o 0). */
export function matchesText(item: Filterable, query: string) {
  const q = query.trim();
  if (!q) return true;
  const name = `${item.contactName || ''} ${item.user?.name || ''} ${item.title}`;
  if (plain(name).includes(plain(q))) return true;
  const qd = digits(q).replace(/^0/, '');
  const phones = [item.contactPhone, item.user?.phone].filter(Boolean).map((p) => digits(p!));
  return qd.length >= 3 && phones.some((p) => p.includes(qd));
}

export function filterAppointments<T extends Filterable>(
  items: T[],
  options: {
    status: StatusFilter;
    date: DateFilter;
    from?: string;
    to?: string;
    query?: string;
    /** Mantener el orden recibido (el backend ya ordenó por el criterio elegido). */
    keepOrder?: boolean;
  },
  now = Date.now(),
) {
  const today = visitDayKey(now);
  const inWeek = visitDayKey(now + 7 * 86400000);
  const shown = items.filter((item) => {
    if (!matchesStatus(item, options.status) || !matchesText(item, options.query || ''))
      return false;
    const day = visitDayKey(item.startsAt);
    switch (options.date) {
      case 'today':
        return day === today;
      case 'upcoming':
        return day >= today;
      case 'week':
        return day >= today && day <= inWeek;
      case 'past':
        return day < today;
      case 'custom':
        return (!options.from || day >= options.from) && (!options.to || day <= options.to);
      default:
        return true;
    }
  });
  if (options.keepOrder) return shown;
  // Lo pendiente de atender, de la más próxima a la más lejana; el historial, de la más reciente.
  const ascending =
    options.status === 'active' ||
    options.date === 'today' ||
    options.date === 'upcoming' ||
    options.date === 'week';
  return shown.sort((a, b) => {
    const diff = new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime();
    return ascending ? diff : -diff;
  });
}
