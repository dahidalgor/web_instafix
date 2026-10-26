import { BusyButton } from '../../components/ui/BusyButton';
import { ListSkeleton } from '../../components/ui/Skeleton';
import { useEffect, useState } from 'react';
import {
  homeSections,
  pageLabels,
  publicPages,
  type AnalyticsSummary,
  type TrackedPage,
} from '@instafix/contracts/src/site';
import { api } from '../../lib/api';

type Row = { page: string; label: string; visits: number; averageSeconds: number };
const duration = (seconds: number) =>
  seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;

/**
 * Filas de la tabla: todas las páginas y secciones de Inicio de la web actual (también las que
 * no tienen visitas), de más a menos visitada. Un nombre que ya no existe se muestra aparte.
 */
export function analyticsRows(data: AnalyticsSummary) {
  const byPage = new Map(data.pages.map((p) => [p.page, p]));
  const build = (pages: readonly TrackedPage[]) =>
    pages
      .map((page) => ({
        page,
        label: pageLabels[page],
        visits: byPage.get(page)?.visits ?? 0,
        averageSeconds: byPage.get(page)?.averageSeconds ?? 0,
      }))
      .sort((a, b) => b.visits - a.visits || a.label.localeCompare(b.label, 'es'));
  const known = new Set<string>([...publicPages, ...homeSections]);
  const other = data.pages.filter((p) => !known.has(p.page)).map((p) => ({ ...p, label: p.page }));
  return { pages: build(publicPages), sections: build(homeSections), other };
}

export function AdminAnalytics() {
  const [data, setData] = useState<AnalyticsSummary | null>(null);
  const [error, setError] = useState('');
  function load() {
    setError('');
    return api<AnalyticsSummary>('admin/analytics')
      .then(setData)
      .catch((e) => setError(e.message));
  }
  useEffect(() => {
    void load();
  }, []);
  const rows = data ? analyticsRows(data) : null;
  const table = (title: string, list: Row[], note?: string) => (
    <div className="analytics-block">
      <h2>{title}</h2>
      {note && <p className="small">{note}</p>}
      <div className="admin-table-scroll">
        <table className="analytics-table">
          <thead>
            <tr>
              <th scope="col">Página</th>
              <th scope="col">Visitas</th>
              <th scope="col">% del total</th>
              <th scope="col">Tiempo promedio</th>
            </tr>
          </thead>
          <tbody>
            {list.map((row) => {
              const share = data!.visits ? Math.round((row.visits / data!.visits) * 100) : 0;
              return (
                <tr key={row.page} className={row.visits ? '' : 'is-empty'}>
                  <th scope="row">{row.label}</th>
                  <td>{row.visits}</td>
                  <td>
                    <span className="analytics-bar" style={{ ['--share' as string]: `${share}%` }}>
                      {share}%
                    </span>
                  </td>
                  <td>{row.visits ? duration(row.averageSeconds) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
  return (
    <section className="analytics-admin">
      <div className="analytics-head">
        {data && (
          <div className="analytics-totals" role="status">
            <div>
              <strong>{data.visits}</strong>
              <span>visitas</span>
            </div>
            <div>
              <strong>{data.sessions}</strong>
              <span>sesiones</span>
            </div>
            <div>
              <strong>{data.days}</strong>
              <span>días</span>
            </div>
          </div>
        )}
        <BusyButton
          type="button"
          className="btn btn-secondary btn-small"
          busyLabel="Actualizando…"
          onClick={() => load()}
        >
          Actualizar
        </BusyButton>
      </div>
      {error && <p role="alert">{error}</p>}
      {!data && !error && <ListSkeleton label="Cargando estadísticas…" count={4} />}
      {rows && (
        <>
          {table('Páginas', rows.pages)}
          {table(
            'Secciones de Inicio',
            rows.sections,
            'Cuenta cada vez que alguien llega a la sección con un enlace del menú o de un botón; desplazarse por Inicio no suma.',
          )}
          {rows.other.length > 0 &&
            table('Otras páginas', rows.other, 'Nombres antiguos que ya no existen en la web.')}
          <p className="small">
            Una visita = una apertura de página o sección. El tiempo promedio cuenta solo el tiempo
            con la página visible. Las sesiones son pestañas del navegador, no personas. Respeta «No
            rastrear», no incluye los paneles del equipo ni guarda IP ni datos personales.
            Retención: 90 días.
          </p>
        </>
      )}
    </section>
  );
}
