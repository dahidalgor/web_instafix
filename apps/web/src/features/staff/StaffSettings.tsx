import type { AccountUser } from '@instafix/contracts';
import { maskPhone } from '@instafix/contracts/src/phone';
import { useState } from 'react';
import { ThemeOptions } from '../../components/layout/AccountMenu';
import { AccountSecurity } from '../account/AccountSecurity';
import { DeviceNotifications } from '../notifications/DeviceNotifications';
import { browserEnv, isIos } from '../notifications/push-client';

const roles: Record<AccountUser['role'], string> = {
  ADMIN: 'Administrador',
  TECHNICIAN: 'Técnico',
  CUSTOMER: 'Cliente',
};

/**
 * Mi cuenta / Ajustes del equipo (técnicos y administración):
 * perfil · cuenta y seguridad · apariencia · app (instalación) · notificaciones · sesión.
 * Reutiliza la seguridad de las cuentas de cliente: cambiar WhatsApp con código, correo con
 * enlace de verificación y contraseña con la actual.
 */
export function StaffSettings({
  user,
  onUser,
  onLogout,
}: {
  user: AccountUser;
  onUser: (user: AccountUser) => void;
  onLogout: () => void;
}) {
  const [env] = useState(browserEnv);
  const ios = isIos(env);
  const initials =
    (user.firstName?.[0] ?? user.name[0] ?? '') +
    (user.lastName?.[0] ?? user.name.split(' ')[1]?.[0] ?? '');

  return (
    <div className="settings-stack">
      <section className="settings-card settings-profile" aria-labelledby="settings-profile">
        <span className="settings-avatar" aria-hidden="true">
          {initials.toUpperCase()}
        </span>
        <div>
          <h2 id="settings-profile">{user.name}</h2>
          <p>
            <span className="settings-role">{roles[user.role]}</span>
            {maskPhone(user.phone)}
          </p>
        </div>
      </section>

      <section className="settings-card" aria-labelledby="settings-security">
        <div className="settings-card-head">
          <h2 id="settings-security">Cuenta y seguridad</h2>
          <p>Tu WhatsApp (con él inicias sesión), tu correo y tu contraseña.</p>
        </div>
        <AccountSecurity user={user} onUser={onUser} />
      </section>

      <section className="settings-card" aria-labelledby="settings-theme">
        <div className="settings-card-head">
          <h2 id="settings-theme">Apariencia</h2>
          <p>Se guarda en este dispositivo.</p>
        </div>
        <ThemeOptions labelId="settings-theme" showLabel={false} />
      </section>

      <section className="settings-card" aria-labelledby="settings-app">
        <div className="settings-card-head">
          <h2 id="settings-app">App</h2>
          <p>Instafix funciona como una app desde la pantalla de inicio.</p>
        </div>
        {env.standalone ? (
          <p className="settings-ok">✓ Instafix está instalada y abierta como app.</p>
        ) : ios ? (
          <ol className="settings-steps">
            <li>
              Abre <b>{window.location.host}</b> en <b>Safari</b>.
            </li>
            <li>
              Pulsa <b>Compartir</b> → <b>Añadir a pantalla de inicio</b>.
            </li>
            <li>Abre Instafix desde el icono nuevo e inicia sesión.</li>
          </ol>
        ) : (
          <p>
            En Android o en el ordenador, usa el menú del navegador → <b>Instalar aplicación</b> (o
            «Añadir a pantalla de inicio»).
          </p>
        )}
      </section>

      <section className="settings-card" aria-labelledby="settings-notifications">
        <div className="settings-card-head">
          <h2 id="settings-notifications">Notificaciones</h2>
          <p>Aviso en este dispositivo cuando un cliente solicita una cita.</p>
        </div>
        <DeviceNotifications />
      </section>

      <section className="settings-card settings-session" aria-labelledby="settings-session">
        <div>
          <h2 id="settings-session">Sesión</h2>
          <p>Al cerrar sesión, este dispositivo deja de recibir notificaciones.</p>
        </div>
        <button type="button" className="btn btn-ghost" onClick={onLogout}>
          Cerrar sesión
        </button>
      </section>
    </div>
  );
}
