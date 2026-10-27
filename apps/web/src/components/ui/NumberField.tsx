import { useEffect, useState, type InputHTMLAttributes } from 'react';

/** Texto escrito → texto limpio: sin ceros a la izquierda («05» → «5»), coma o punto decimal. */
export function cleanNumberText(raw: string, decimals = 0) {
  let text = raw.replace(/\s/g, '').replace(',', '.');
  if (!decimals) text = text.replace(/\D/g, '');
  else {
    text = text.replace(/[^\d.]/g, '');
    const [whole, ...rest] = text.split('.');
    text = rest.length ? `${whole}.${rest.join('').slice(0, decimals)}` : whole;
  }
  // «007» → «7», «0.5» se conserva, «.5» → «0.5».
  text = text.replace(/^0+(?=\d)/, '');
  if (text.startsWith('.')) text = `0${text}`;
  return text;
}
export const numberFromText = (text: string) => (text === '' || text === '.' ? 0 : Number(text));

/**
 * Campo numérico sin el «0» pegado delante: un <input type="number"> controlado deja «05» al
 * escribir sobre un 0. Este campo guarda el texto mientras se escribe, abre el teclado numérico
 * en el móvil y entrega siempre un número.
 */
export function NumberField({
  value,
  onValue,
  decimals = 0,
  ...rest
}: {
  value: number;
  onValue: (value: number) => void;
  /** Decimales permitidos (2 para precios). */
  decimals?: number;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'>) {
  const [text, setText] = useState(() => (value ? String(value) : ''));
  // Si el valor cambia desde fuera (abrir otro servicio, limpiar el formulario), se muestra.
  useEffect(() => {
    if (numberFromText(text) !== value) setText(value ? String(value) : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <input
      {...rest}
      type="text"
      inputMode={decimals ? 'decimal' : 'numeric'}
      autoComplete="off"
      placeholder={rest.placeholder ?? '0'}
      value={text}
      onChange={(event) => {
        const next = cleanNumberText(event.target.value, decimals);
        setText(next);
        onValue(numberFromText(next));
      }}
    />
  );
}
