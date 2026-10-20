import type { AccountUser } from '@instafix/contracts';
import { useCallback, useEffect, useState } from 'react';
import { LOGOUT_EVENT } from '../../components/layout/AccountMenu';
import { Skeleton, SkeletonGroup } from '../../components/ui/Skeleton';
import { api, ApiError } from '../../lib/api';
import { linkToken } from './account-links';
import { AccountSecurity } from './AccountSecurity';
import { Login } from './Login';

/** Ajustes de la cuenta (menú de usuario → Ajustes): WhatsApp, correo y contraseña. */
export function AccountSettings() {
  const [user, setUser] = useState<AccountUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const loadSession = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setUser(await api<AccountUser>('auth/me'));
    } catch (e) {
      // 401 = sin sesión: se muestra el inicio de sesión.
      if (!(e instanceof ApiError && e.status === 401))
        setError(e instanceof Error ? e.message : 'No pudimos conectar con tu cuenta.');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    const token = linkToken('verificar-correo');
    if (!token) {
      void loadSession();
      return;
    }
    // El enlace del correo se consume una vez y se retira de la barra de direcciones.
    history.replaceState(null, '', '#ajustes');
    api('auth/email/verify', { method: 'POST', body: JSON.stringify({ token }) })
      .then(() => setNotice('✓ Tu correo quedó verificado.'))
      .catch((e) => setNotice(e.message))
      .finally(() => void loadSession());
  }, [loadSession]);
  useEffect(() => {
    const signedOut = () => setUser(null);
    window.addEventListener(LOGOUT_EVENT, signedOut);
    return () => window.removeEventListener(LOGOUT_EVENT, signedOut);
  }, []);

  if (loading)
    return (
      <section className="account-panel wide">
        <SkeletonGroup label="Cargando ajustes…">
          <Skeleton width={150} height={14} />
          <Skeleton width="min(420px, 80%)" height={44} className="skeleton-heading" />
          <Skeleton width="100%" height={88} />
          <Skeleton width="100%" height={88} />
          <Skeleton width="100%" height={88} />
        </SkeletonGroup>
      </section>
    );
  if (error)
    return (
      <section className="account-panel">
        <p role="alert">{error}</p>
        <button className="btn btn-primary" onClick={() => void loadSession()}>
          Reintentar
        </button>
      </section>
    );
  if (!user)
    return (
      <>
        {notice && (
          <p role="status" className="account-banner">
            {notice}
          </p>
        )}
        <Login onLogin={setUser} />
      </>
    );
  return (
    <section className="account-panel wide account-settings">
      <div className="account-heading">
        <div>
          <p className="eyebrow">TU ESPACIO INSTAFIX</p>
          <h1>Ajustes de la cuenta</h1>
          <p>Tu WhatsApp, tu correo y tu contraseña.</p>
        </div>
        <a className="btn btn-ghost btn-small" href="#cuenta">
          ← Ir a mi cuenta
        </a>
      </div>
      {notice && (
        <p role="status" className="account-banner">
          {notice}
        </p>
      )}
      <AccountSecurity user={user} onUser={setUser} />
    </section>
  );
}
