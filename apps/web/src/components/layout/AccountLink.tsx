import { useEffect, useState } from 'react';

/** Comprueba la cookie real; no persiste un indicador de sesión en el navegador. */
export function AccountLink({ active, onNavigate }: { active: boolean; onNavigate: () => void }) {
  const [signedIn, setSignedIn] = useState(false);
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
  const label = signedIn ? 'Mi cuenta: sesión iniciada' : 'Iniciar sesión';
  return (
    <a
      href="#cuenta"
      className="account-link"
      aria-label={label}
      title={label}
      aria-current={active ? 'page' : undefined}
      onClick={onNavigate}
    >
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
    </a>
  );
}
