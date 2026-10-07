import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
export function WarrantyPolicy() {
  const [text, setText] = useState('Cargando políticas…');
  useEffect(() => {
    api('warranty-policy')
      .then((value) => setText(value.text))
      .catch(() => setText('No se pudieron cargar las políticas. Intenta nuevamente más tarde.'));
  }, []);
  return (
    <section className="account-panel wide">
      <p className="eyebrow">INFORMACIÓN DE SERVICIO</p>
      <h1>Políticas de garantía</h1>
      <p className="service-description">{text}</p>
      <a href="#cuenta" className="text-button">
        Consultar la garantía de mis trabajos →
      </a>
    </section>
  );
}
