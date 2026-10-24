import type { AccountUser } from '@instafix/contracts';
import { useEffect, useRef, type ReactNode } from 'react';
import { ThemeOptions } from '../../components/layout/AccountMenu';
import {
  adminGroups,
  findAdminItem,
  icons,
  mobilePrimary,
  type AdminNavItem,
  type AdminTab,
} from './admin-nav';

type Props = {
  user: AccountUser;
  tab: AdminTab;
  onSelect: (tab: AdminTab) => void;
  onLogout: () => void;
  /** Mientras se sube un archivo no se cambia de ventana (se perdería la subida). */
  locked: boolean;
  message?: ReactNode;
  children: ReactNode;
};

/**
 * Estructura de Administración.
 * Escritorio: barra lateral con las cuatro secciones y la ventana a la derecha.
 * Móvil: barra inferior con los accesos principales y «Más» con todas las ventanas.
 */
export function AdminShell({ user, tab, onSelect, onLogout, locked, message, children }: Props) {
  const current = findAdminItem(tab);
  const sheet = useRef<HTMLDialogElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const select = (next: AdminTab) => {
    sheet.current?.close();
    if (next === tab) return;
    onSelect(next);
  };
  // Al cambiar de ventana se vuelve arriba: la nueva no empieza a media página.
  useEffect(() => {
    window.scrollTo({ top: 0 });
    content.current?.focus({ preventScroll: true });
  }, [tab]);
  const moreActive = !mobilePrimary.includes(tab);
  const firstName = user.firstName || user.name.split(' ')[0];

  return (
    <div className="admin-shell">
      <aside className="admin-sidebar" aria-label="Administración">
        <a className="admin-brand" href="#">
          InstaFix <span>Administración</span>
        </a>
        <nav data-admin-nav aria-label="Secciones de administración">
          {adminGroups.map((group) => (
            <div className="admin-nav-group" key={group.id}>
              <p id={`nav-${group.id}`}>{group.label}</p>
              <ul aria-labelledby={`nav-${group.id}`}>
                {group.items.map((item) => (
                  <li key={item.id}>
                    <NavButton
                      item={item}
                      active={item.id === tab}
                      locked={locked}
                      onSelect={select}
                    />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <div className="admin-sidebar-foot">
          <span title={user.name}>{firstName}</span>
          <button type="button" className="btn btn-ghost btn-small" onClick={onLogout}>
            {icons.salir}
            Cerrar sesión
          </button>
        </div>
      </aside>

      <main className="admin-main">
        <div className="admin-topbar">
          <span className="admin-brand">
            InstaFix <span>Administración</span>
          </span>
        </div>
        <div className="admin-pagehead">
          <p className="eyebrow">{current.group}</p>
          <h1>{current.label}</h1>
          <p>{current.description}</p>
        </div>
        {message}
        <div className="admin-content" ref={content} tabIndex={-1}>
          {children}
        </div>
      </main>

      <nav className="admin-tabbar" data-admin-nav aria-label="Accesos rápidos">
        {mobilePrimary.map((id) => (
          <NavButton
            key={id}
            item={findAdminItem(id)}
            active={id === tab}
            locked={locked}
            onSelect={select}
            compact
          />
        ))}
        <button
          type="button"
          className="admin-nav-item is-compact"
          data-admin-more
          aria-current={moreActive ? 'page' : undefined}
          aria-haspopup="dialog"
          disabled={locked}
          onClick={() => sheet.current?.showModal()}
        >
          {icons.mas}
          <span>{moreActive ? (current.short ?? current.label) : 'Más'}</span>
        </button>
      </nav>

      <dialog
        ref={sheet}
        className="admin-more-sheet"
        aria-labelledby="admin-more-title"
        onClick={(event) => {
          // Tocar fuera de la hoja la cierra.
          if (event.target === event.currentTarget) sheet.current?.close();
        }}
      >
        <div className="admin-more-inner">
          <div className="admin-more-head">
            <h2 id="admin-more-title">Todas las opciones</h2>
            <button
              type="button"
              className="admin-more-close"
              aria-label="Cerrar"
              onClick={() => sheet.current?.close()}
            >
              ×
            </button>
          </div>
          {adminGroups.map((group) => (
            <section key={group.id} aria-labelledby={`more-${group.id}`}>
              <h3 id={`more-${group.id}`}>{group.label}</h3>
              <div className="admin-more-grid">
                {group.items.map((item) => (
                  <NavButton
                    key={item.id}
                    item={item}
                    active={item.id === tab}
                    locked={locked}
                    onSelect={select}
                    tile
                  />
                ))}
              </div>
            </section>
          ))}
          <ThemeOptions labelId="admin-more-theme" />
          <div className="admin-more-account">
            <span>
              Sesión: <strong>{user.name}</strong>
            </span>
            <button type="button" className="btn btn-ghost" onClick={onLogout}>
              {icons.salir}
              Cerrar sesión
            </button>
          </div>
        </div>
      </dialog>
    </div>
  );
}

function NavButton({
  item,
  active,
  locked,
  onSelect,
  compact,
  tile,
}: {
  item: AdminNavItem;
  active: boolean;
  locked: boolean;
  onSelect: (tab: AdminTab) => void;
  compact?: boolean;
  tile?: boolean;
}) {
  return (
    <button
      type="button"
      data-tab={item.id}
      className={`admin-nav-item${compact ? ' is-compact' : ''}${tile ? ' is-tile' : ''}`}
      aria-current={active ? 'page' : undefined}
      disabled={locked && !active}
      onClick={() => onSelect(item.id)}
    >
      {item.icon}
      <span>{compact ? (item.short ?? item.label) : item.label}</span>
    </button>
  );
}
