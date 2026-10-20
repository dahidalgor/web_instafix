import type { CSSProperties, ReactNode } from 'react';

/**
 * Bloques de carga con la forma aproximada del contenido final. Solo se muestran mientras
 * se espera una respuesta: una respuesta vacía muestra su estado vacío, nunca un skeleton.
 */
export function Skeleton({
  width,
  height = '1em',
  radius,
  className = '',
}: {
  width?: CSSProperties['width'];
  height?: CSSProperties['height'];
  radius?: CSSProperties['borderRadius'];
  className?: string;
}) {
  return (
    <span
      className={`skeleton ${className}`}
      style={{ width, height, borderRadius: radius }}
      aria-hidden="true"
    />
  );
}

/** Contenedor accesible: anuncia una sola vez «Cargando…» y oculta los bloques al lector. */
export function SkeletonGroup({
  label,
  className = '',
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`skeleton-group ${className}`}
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <span className="visually-hidden">{label}</span>
      {children}
    </div>
  );
}

const repeat = (count: number) => Array.from({ length: count }, (_, i) => i);

/** Tarjeta de servicio: equipo y disponibilidad, título, precio y metadatos. */
export function ServiceCardSkeleton() {
  return (
    <div className="card skeleton-card">
      <Skeleton className="skeleton-media" height={150} radius={10} />
      <div className="skeleton-row">
        <Skeleton width="38%" height={12} />
        <Skeleton width={78} height={22} radius={999} />
      </div>
      <Skeleton width="80%" height={20} />
      <div className="skeleton-row">
        <Skeleton width={70} height={24} />
        <Skeleton width="34%" height={12} />
      </div>
    </div>
  );
}

/** Misma estructura que AppointmentCard: estado, hora, cliente, solicitud y acciones. */
export function AppointmentCardSkeleton({ actions = true }: { actions?: boolean }) {
  return (
    <div className="appt-card skeleton-card">
      <Skeleton width={120} height={26} radius={999} />
      <div className="skeleton-row is-start">
        <Skeleton width={74} height={30} />
        <Skeleton width={96} height={14} />
      </div>
      <Skeleton width="45%" height={14} />
      <Skeleton width="90%" height={14} />
      <Skeleton width="70%" height={14} />
      {actions && (
        <div className="skeleton-row">
          <Skeleton width="48%" height={44} radius={10} />
          <Skeleton width="48%" height={44} radius={10} />
        </div>
      )}
    </div>
  );
}

/** Fila de listado administrativo (equipo, trabajos, servicios, mensajes). */
export function RowSkeleton() {
  return (
    <div className="skeleton-list-row">
      <div>
        <Skeleton width="55%" height={16} />
        <Skeleton width="80%" height={12} />
      </div>
      <Skeleton width={96} height={36} radius={10} />
    </div>
  );
}

export function ListSkeleton({
  label,
  count = 3,
  variant = 'row',
  className = '',
}: {
  label: string;
  count?: number;
  variant?: 'row' | 'appointment' | 'service';
  className?: string;
}) {
  return (
    <SkeletonGroup label={label} className={className}>
      {repeat(count).map((i) =>
        variant === 'appointment' ? (
          <AppointmentCardSkeleton key={i} />
        ) : variant === 'service' ? (
          <ServiceCardSkeleton key={i} />
        ) : (
          <RowSkeleton key={i} />
        ),
      )}
    </SkeletonGroup>
  );
}

/** Indicadores numéricos (resumen de Mi cuenta, estadísticas). */
export function StatTilesSkeleton({ count = 3, label = 'Cargando resumen…' }) {
  return (
    <SkeletonGroup label={label} className="skeleton-stats">
      {repeat(count).map((i) => (
        <div key={i} className="skeleton-stat">
          <Skeleton width={46} height={30} />
          <Skeleton width="70%" height={12} />
        </div>
      ))}
    </SkeletonGroup>
  );
}

/** Párrafos de texto (políticas, descripciones largas). */
export function TextSkeleton({ lines = 4, label = 'Cargando…' }) {
  return (
    <SkeletonGroup label={label} className="skeleton-text">
      {repeat(lines).map((i) => (
        <Skeleton key={i} width={i === lines - 1 ? '60%' : '100%'} height={14} />
      ))}
    </SkeletonGroup>
  );
}
