import type { AccountUser } from '@instafix/contracts';
import { useEffect, useRef, type ReactNode } from 'react';

export type StaffNavItem<T extends string = string> = {
  id: T;
  label: string;
  /** Nombre corto para la barra inferior del móvil. */
  short?: string;
  description: string;
  icon: ReactNode;
};
export type StaffNavGroup<T extends string = string> = {
  id: string;
  label: string;
  items: StaffNavItem<T>[];
};

type Props<T extends string> = {
  /** «Administración», «Técnicos»… */
  area: string;
  user: AccountUser;
  groups: StaffNavGroup<T>[];
  /** Accesos fijos de la barra inferior (máx. 5). Si no caben todos, aparece «Más». */
  primary: T[];
  tab: T;
  onSelect: (tab: T) => void;
  onLogout: () => void;
  /** Ventana de la cuenta del usuario (perfil, apariencia, notificaciones). */
  accountTab?: T;
  /** Contadores junto a cada opción (p. ej. citas pendientes). */
  badges?: Partial<Record<T, number>>;
  /** Mientras se sube un archivo no se cambia de ventana (se perdería la subida). */
  locked?: boolean;
  message?: ReactNode;
  children: ReactNode;
};

const svg = (children: ReactNode) => (
  <svg
    viewBox="0 0 24 24"
    width="22"
    height="22"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    {children}
  </svg>
);
export const shellIcons = {
  mas: svg(
    <>
      <circle cx="5" cy="12" r="1.2" fill="currentColor" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" />
      <circle cx="19" cy="12" r="1.2" fill="currentColor" />
    </>,
  ),
  salir: svg(<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10" />),
  cuenta: svg(
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </>,
  ),
  ajustes: svg(
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </>,
  ),
};
export const staffSvg = svg;

/**
 * Estructura común de los paneles del equipo (Administración y Técnicos).
 * Escritorio: barra lateral con las secciones y la ventana a la derecha.
 * Móvil: barra superior compacta, barra inferior tipo app y, si no caben todas las opciones,
 * «Más» con todas las ventanas agrupadas.
 */
export function StaffShell<T extends string>({
  area,
  user,
  groups,
  primary,
  tab,
  onSelect,
  onLogout,
  accountTab,
  badges = {},
  locked = false,
  message,
  children,
}: Props<T>) {
  const items = groups.flatMap((group) =>
    group.items.map((item) => ({ ...item, group: group.label })),
  );
  const current = items.find((item) => item.id === tab) ?? items[0];
  const sheet = useRef<HTMLDialogElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const select = (next: T) => {
    sheet.current?.close();
    if (next !== tab) onSelect(next);
  };
  // Al cambiar de ventana se vuelve arriba: la nueva no empieza a media página.
  useEffect(() => {
    window.scrollTo({ top: 0 });
    content.current?.focus({ preventScroll: true });
  }, [tab]);
  const hasMore = items.some((item) => !primary.includes(item.id));
  const moreActive = hasMore && !primary.includes(tab);
  const firstName = user.firstName || user.name.split(' ')[0];
  const badge = (id: T) => badges[id] ?? 0;

  return (
    <div className="admin-shell">
      <aside className="admin-sidebar" aria-label={area}>
        <a className="admin-brand" href="#">
          InstaFix <span>{area}</span>
        </a>
        <nav data-admin-nav aria-label={`Secciones de ${area.toLowerCase()}`}>
          {groups.map((group) => (
            <div className="admin-nav-group" key={group.id}>
              <p id={`nav-${group.id}`}>{group.label}</p>
              <ul aria-labelledby={`nav-${group.id}`}>
                {group.items.map((item) => (
                  <li key={item.id}>
                    <NavButton
                      item={item}
                      active={item.id === tab}
                      locked={locked}
                      badge={badge(item.id)}
                      onSelect={select}
                    />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <div className="admin-sidebar-foot">
          {accountTab ? (
            <button
              type="button"
              className="admin-sidebar-user"
              title="Mi cuenta"
              aria-current={tab === accountTab ? 'page' : undefined}
              disabled={locked}
              onClick={() => select(accountTab)}
            >
              {shellIcons.cuenta}
              <span>{firstName}</span>
            </button>
          ) : (
            <span title={user.name}>{firstName}</span>
          )}
          <button type="button" className="btn btn-ghost btn-small" onClick={onLogout}>
            {shellIcons.salir}
            Salir
          </button>
        </div>
      </aside>

      <main className="admin-main">
        <div className="admin-topbar">
          <span className="admin-brand">
            InstaFix <span>{area}</span>
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

      <nav
        className={`admin-tabbar cols-${primary.length + (hasMore ? 1 : 0)}`}
        data-admin-nav
        aria-label="Accesos rápidos"
      >
        {primary.map((id) => {
          const item = items.find((entry) => entry.id === id)!;
          return (
            <NavButton
              key={id}
              item={item}
              active={id === tab}
              locked={locked}
              badge={badge(id)}
              onSelect={select}
              compact
            />
          );
        })}
        {hasMore && (
          <button
            type="button"
            className="admin-nav-item is-compact"
            data-admin-more
            aria-current={moreActive ? 'page' : undefined}
            aria-haspopup="dialog"
            disabled={locked}
            onClick={() => sheet.current?.showModal()}
          >
            {shellIcons.mas}
            <span>{moreActive ? (current.short ?? current.label) : 'Más'}</span>
          </button>
        )}
      </nav>

      {hasMore && (
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
            {groups.map((group) => (
              <section key={group.id} aria-labelledby={`more-${group.id}`}>
                <h3 id={`more-${group.id}`}>{group.label}</h3>
                <div className="admin-more-grid">
                  {group.items.map((item) => (
                    <NavButton
                      key={item.id}
                      item={item}
                      active={item.id === tab}
                      locked={locked}
                      badge={badge(item.id)}
                      onSelect={select}
                      tile
                    />
                  ))}
                </div>
              </section>
            ))}
            <div className="admin-more-account">
              <span>
                Sesión: <strong>{user.name}</strong>
              </span>
              <button type="button" className="btn btn-ghost" onClick={onLogout}>
                {shellIcons.salir}
                Cerrar sesión
              </button>
            </div>
          </div>
        </dialog>
      )}
    </div>
  );
}

function NavButton<T extends string>({
  item,
  active,
  locked,
  badge,
  onSelect,
  compact,
  tile,
}: {
  item: StaffNavItem<T>;
  active: boolean;
  locked: boolean;
  badge: number;
  onSelect: (tab: T) => void;
  compact?: boolean;
  tile?: boolean;
}) {
  const label = compact ? (item.short ?? item.label) : item.label;
  return (
    <button
      type="button"
      data-tab={item.id}
      className={`admin-nav-item${compact ? ' is-compact' : ''}${tile ? ' is-tile' : ''}`}
      aria-current={active ? 'page' : undefined}
      aria-label={badge ? `${item.label} (${badge})` : undefined}
      disabled={locked && !active}
      onClick={() => onSelect(item.id)}
    >
      <span className="admin-nav-icon">
        {item.icon}
        {badge > 0 && (
          <span className="admin-nav-badge" aria-hidden="true">
            {badge > 99 ? '99+' : badge}
          </span>
        )}
      </span>
      <span className="admin-nav-label">{label}</span>
    </button>
  );
}
