import { useEffect, useState } from 'react';
import { TextSkeleton } from '../../components/ui/Skeleton';
import { api } from '../../lib/api';
export function WarrantyPolicy() {
  // null: cargando · string: texto publicado · error: mensaje propio.
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api('warranty-policy')
      .then((value) => setText(value.text))
      .catch(() => setError('No se pudieron cargar las políticas. Intenta nuevamente más tarde.'));
  }, []);
  return (
    <section className="account-panel wide">
      <p className="eyebrow">INFORMACIÓN DE SERVICIO</p>
      <h1>Políticas de garantía</h1>
      {error ? (
        <p role="alert">{error}</p>
      ) : text === null ? (
        <TextSkeleton lines={8} label="Cargando políticas…" />
      ) : (
        <p className="service-description">{text}</p>
      )}
      <a href="#cuenta" className="text-button">
        Consultar la garantía de mis trabajos →
      </a>
    </section>
  );
}
