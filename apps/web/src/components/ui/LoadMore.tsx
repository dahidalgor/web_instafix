import { BusyButton } from './BusyButton';

/** «Cargar más» al final de una lista larga, con cuántos se ven de cuántos hay. */
export function LoadMore({
  shown,
  total,
  loading,
  onMore,
  noun = 'resultados',
}: {
  shown: number;
  total: number;
  loading: boolean;
  onMore: () => void;
  noun?: string;
}) {
  if (!total) return null;
  return (
    <div className="load-more">
      <p className="small">
        {shown < total ? `Mostrando ${shown} de ${total} ${noun}` : `${total} ${noun}`}
      </p>
      {shown < total && (
        <BusyButton
          type="button"
          className="btn btn-secondary"
          busy={loading}
          busyLabel="Cargando…"
          onClick={onMore}
        >
          Cargar más
        </BusyButton>
      )}
    </div>
  );
}
