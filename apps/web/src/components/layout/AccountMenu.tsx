import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { BusyButton } from '../ui/BusyButton';

/** Avisa a Mi cuenta y Ajustes de que la sesión se cerró desde el menú. */
export const LOGOUT_EVENT = 'instafix:logout';

/**
 * Botón de usuario del encabezado. Sin sesión lleva a iniciar sesión; con sesión despliega
 * «Ir a mi cuenta», «Ajustes» y «Cerrar sesión». Comprueba la cookie real (no guarda un
 * indicador de sesión en el navegador).
 */
export function AccountMenu({ active, onNavigate }: { active: boolean; onNavigate: () => void }) {
  const [signedIn, setSignedIn] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let controller: AbortController | undefined;
    const refresh = async () => {
      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal;
      try {
        const response = await fetch('/api/v1/auth/me', { credentials: 'same-origin', signal });
        if (!signal.aborted) setSignedIn(response.ok);
      } catch {
        if (!signal.aborted) setSignedIn(false);
      }
    };
    const visible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    void refresh();
    window.addEventListener('instafix:session-change', refresh);
    window.addEventListener('focus', visible);
    document.addEventListener('visibilitychange', visible);
    return () => {
      controller?.abort();
      window.removeEventListener('instafix:session-change', refresh);
      window.removeEventListener('focus', visible);
      document.removeEventListener('visibilitychange', visible);
    };
  }, []);
  // Se cierra al hacer clic fuera, con Escape o al cambiar de página.
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      toggle.current?.focus();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    window.addEventListener('hashchange', close);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
      window.removeEventListener('hashchange', close);
    };
    function close() {
      setOpen(false);
    }
  }, [open]);
  useEffect(() => {
    if (!signedIn) setOpen(false);
  }, [signedIn]);

  async function logout() {
    setError('');
    try {
      await api('auth/logout', { method: 'POST' });
      setSignedIn(false);
      setOpen(false);
      window.dispatchEvent(new Event(LOGOUT_EVENT));
    } catch {
      setError('No se pudo cerrar la sesión. Inténtalo nuevamente.');
    }
  }

  const icon = (
    <>
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        aria-hidden="true"
      >
        <circle cx="12" cy="8" r="3.5" />
        <path d="M4.5 21v-2a7.5 7.5 0 0 1 15 0v2" strokeLinecap="round" />
      </svg>
      {signedIn && (
        <span className="account-session-check" aria-hidden="true">
          <svg viewBox="0 0 16 16" fill="none">
            <path
              d="m4 8 2.5 2.5L12 5"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      )}
    </>
  );
  if (!signedIn)
    return (
      <div className="account-menu">
        <a
          href="#cuenta"
          className="account-link"
          aria-label="Iniciar sesión"
          title="Iniciar sesión"
          aria-current={active ? 'page' : undefined}
          onClick={onNavigate}
        >
          {icon}
        </a>
      </div>
    );
  const pick = () => {
    setOpen(false);
    onNavigate();
  };
  return (
    <div className="account-menu" ref={root}>
      <button
        ref={toggle}
        type="button"
        className="account-link"
        aria-label="Menú de usuario: sesión iniciada"
        title="Mi cuenta"
        aria-expanded={open}
        aria-controls="account-menu-panel"
        data-active={active || undefined}
        onClick={() => {
          setError('');
          setOpen((value) => !value);
        }}
      >
        {icon}
      </button>
      {open && (
        <div id="account-menu-panel" className="account-menu-panel">
          <a href="#cuenta" onClick={pick}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="8" r="3.5" />
              <path d="M4.5 21v-2a7.5 7.5 0 0 1 15 0v2" />
            </svg>
            Ir a mi cuenta
          </a>
          <a href="#ajustes" onClick={pick}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
              <circle cx="16" cy="7" r="2" />
              <circle cx="10" cy="17" r="2" />
            </svg>
            Ajustes
          </a>
          <BusyButton
            type="button"
            className="account-menu-logout"
            busyLabel="Cerrando sesión…"
            onClick={logout}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M10 16l-4-4 4-4M6 12h10" />
            </svg>
            Cerrar sesión
          </BusyButton>
          {error && (
            <p role="alert" className="account-menu-error">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
