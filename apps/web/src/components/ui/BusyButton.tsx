import {
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { BusyLabel } from './BusyLabel';

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> & {
  /** Espera controlada desde fuera (p. ej. el envío del formulario al que pertenece). */
  busy?: boolean;
  /** Texto durante la espera; por defecto, el mismo texto del botón. */
  busyLabel?: ReactNode;
  /** Si devuelve una promesa, el botón queda en espera hasta que termine. */
  onClick?: (event: MouseEvent<HTMLButtonElement>) => unknown;
};

/**
 * Botón para acciones con espera: muestra un círculo girando y se desactiva mientras dura,
 * de modo que no se puede lanzar la misma acción dos veces. El ancho no cambia entre estados.
 */
export function BusyButton({
  busy = false,
  busyLabel,
  children,
  disabled,
  onClick,
  ...rest
}: Props) {
  const [pending, setPending] = useState(false);
  // Bloqueo inmediato: un doble clic llega antes de que React vuelva a pintar el botón.
  const lock = useRef(false);
  const active = busy || pending;
  return (
    <button
      {...rest}
      disabled={disabled || active}
      aria-busy={active || undefined}
      onClick={(event) => {
        if (lock.current || active) return;
        const result = onClick?.(event);
        if (!(result instanceof Promise)) return;
        lock.current = true;
        setPending(true);
        void result
          .catch(() => {})
          .finally(() => {
            lock.current = false;
            setPending(false);
          });
      }}
    >
      <BusyLabel busy={active} label={children} busyLabel={busyLabel} />
    </button>
  );
}
