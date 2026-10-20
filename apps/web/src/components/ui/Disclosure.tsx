import { useId, type ReactNode } from 'react';

/**
 * Tarjeta desplegable controlada. El contenido sigue montado al cerrarse (conserva lo escrito)
 * y se oculta con `inert`; la altura se anima con grid-template-rows, sin medir en JS.
 */
export function Disclosure({
  open,
  onToggle,
  title,
  openTitle,
  icon = '+',
  className = '',
  children,
}: {
  open: boolean;
  onToggle: (open: boolean) => void;
  title: ReactNode;
  /** Título mientras está abierta (p. ej. «Nueva cita» o «Editar cita · Ana»). */
  openTitle?: ReactNode;
  icon?: string;
  className?: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section className={`disclosure ${open ? 'is-open' : ''} ${className}`}>
      <button
        type="button"
        className="disclosure-header"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => onToggle(!open)}
      >
        <span className="disclosure-icon" aria-hidden="true">
          {icon}
        </span>
        <span className="disclosure-title">{open ? (openTitle ?? title) : title}</span>
        <span className="disclosure-chevron" aria-hidden="true" />
      </button>
      <div className="disclosure-panel" id={id} inert={!open}>
        <div className="disclosure-inner">{children}</div>
      </div>
    </section>
  );
}
