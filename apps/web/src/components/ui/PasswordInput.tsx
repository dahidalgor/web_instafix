import { useState, type InputHTMLAttributes } from 'react';

/**
 * Campo de contraseña con botón para mostrarla u ocultarla (ojo / ojo tachado). Mismas props que
 * un <input>; se usa dentro de su <label> como cualquier campo. El botón es accesible por
 * teclado, anuncia su estado (aria-pressed) y no envía el formulario.
 */
export function PasswordInput(props: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  const [shown, setShown] = useState(false);
  return (
    <span className={`password-field ${props.className ?? ''}`}>
      <input {...props} className={undefined} type={shown ? 'text' : 'password'} />
      <button
        type="button"
        className="password-toggle"
        aria-label={shown ? 'Ocultar contraseña' : 'Mostrar contraseña'}
        aria-pressed={shown}
        title={shown ? 'Ocultar contraseña' : 'Mostrar contraseña'}
        disabled={props.disabled}
        onClick={() => setShown((value) => !value)}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
          <circle cx="12" cy="12" r="3" />
          {shown && <path d="M4 4l16 16" />}
        </svg>
      </button>
    </span>
  );
}
