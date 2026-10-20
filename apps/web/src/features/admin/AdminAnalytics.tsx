import { ListSkeleton } from '../../components/ui/Skeleton';
import { useEffect, useState } from 'react';
import type { AnalyticsSummary } from '@instafix/contracts/src/site';
import { api } from '../../lib/api';

export function AdminAnalytics() {
  const [data, setData] = useState<AnalyticsSummary | null>(null);
  const [error, setError] = useState('');
  function load() {
    setError('');
    api<AnalyticsSummary>('admin/analytics')
      .then(setData)
      .catch((e) => setError(e.message));
  }
  useEffect(load, []);
  return (
    <section className="editor">
      <h2>Visitas de la web</h2>
      <p>
        Últimos 30 días. El promedio cuenta el tiempo con la página visible, incluyendo visitas
        breves. Las sesiones corresponden a pestañas del navegador, no a personas únicas.
      </p>
      <button type="button" className="btn btn-secondary btn-small" onClick={load}>
        Actualizar
      </button>
      {error && <p role="alert">{error}</p>}
      {!data && !error && <ListSkeleton label="Cargando estadísticas…" count={4} />}
      {data && (
        <>
          <p>
            <strong>{data.visits}</strong> visitas · <strong>{data.sessions}</strong> sesiones
          </p>
          <div className="admin-table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Página</th>
                  <th>Visitas</th>
                  <th>Tiempo promedio</th>
                </tr>
              </thead>
              <tbody>
                {data.pages.map((p) => (
                  <tr key={p.page}>
                    <td>{p.page}</td>
                    <td>{p.visits}</td>
                    <td>
                      {Math.floor(p.averageSeconds / 60)} min {p.averageSeconds % 60} s
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!data.pages.length && <p>Aún no hay visitas registradas.</p>}
          <p className="small">
            Métricas aproximadas: respetan «No rastrear» y no incluyen administración. Sin IP ni
            datos personales. Retención máxima: 90 días.
          </p>
        </>
      )}
    </section>
  );
}
