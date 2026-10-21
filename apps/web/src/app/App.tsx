import { AccountMenu } from '../components/layout/AccountMenu';
import { Contact } from '../features/contact/Contact';
import { usePageAnalytics } from '../features/analytics/usePageAnalytics';
import { useEffect, useRef, useState } from 'react';
import { Brand } from '../components/layout/Brand';
import { SlidingIndicator } from '../components/ui/SlidingIndicator';
import { AccountDashboard } from '../features/account/AccountDashboard';
import { AccountSettings } from '../features/account/AccountSettings';
import { Calendar } from '../features/booking/Calendar';
import { Services } from '../features/catalog/Services';
import { HelpRequest } from '../features/help/HelpRequest';
import { Home } from '../features/home/Home';
import { WarrantyPolicy } from '../features/warranty/WarrantyPolicy';
import { homeSection, resolvePage } from './navigation';
// «Cómo funciona» es una sección de Inicio; el resto son páginas.
const links = [
  ['inicio', 'Inicio'],
  ['servicios', 'Servicios'],
  ['cuenta', 'Mi cuenta'],
  ['agenda', 'Agendar cita'],
] as const;
/** Perfil de Instagram de Instafix. Sin enlace configurado, el pie no lo muestra. */
const INSTAGRAM_URL: string | null = 'https://www.instagram.com/instafix.ec/';
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
/** Desplaza a la sección de Inicio indicada en el enlace, una vez renderizada. */
function scrollToSection(hash: string) {
  const section = homeSection(hash);
  if (!section) return false;
  requestAnimationFrame(() =>
    document
      .getElementById(section)
      ?.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' }),
  );
  return true;
}
export function App() {
  const [page, setPage] = useState(() => resolvePage(window.location.hash));
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  usePageAnalytics(page);
  const main = useRef<HTMLElement>(null);
  const [hash, setHash] = useState(() => window.location.hash);
  const pageRef = useRef(page);
  pageRef.current = page;
  useEffect(() => {
    const navigate = () => {
      const next = resolvePage(window.location.hash);
      setHash(window.location.hash);
      // Misma página (p. ej. de #como a #inicio): no se vuelve a montar; solo se desplaza.
      if (next === pageRef.current) {
        if (!scrollToSection(window.location.hash))
          window.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' });
        return;
      }
      setPage(next);
    };
    window.addEventListener('hashchange', navigate);
    return () => window.removeEventListener('hashchange', navigate);
  }, []);
  useEffect(() => {
    setMenuOpen(false);
    document.title =
      (links.find(([id]) => id === page)?.[1] ??
        (page === 'ajustes'
          ? 'Ajustes de la cuenta'
          : page === 'garantia'
            ? 'Políticas de garantía'
            : page === 'contacto'
              ? 'Contacto'
              : 'Asesoría')) + ' · InstaFix';
    window.scrollTo({ top: 0, behavior: 'instant' });
    main.current?.focus({ preventScroll: true });
    scrollToSection(window.location.hash);
  }, [page]);
  return (
    <>
      <a
        className="skip-link"
        href="#contenido"
        onClick={(e) => {
          e.preventDefault();
          main.current?.focus();
        }}
      >
        Saltar al contenido
      </a>
      <header
        className="public-header"
        onKeyDown={(event) => {
          if (event.key === 'Escape' && menuOpen) {
            setMenuOpen(false);
            menuButton.current?.focus();
          }
        }}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setMenuOpen(false);
        }}
      >
        <Brand />
        <button
          ref={menuButton}
          type="button"
          className="mobile-menu-toggle"
          aria-expanded={menuOpen}
          aria-controls="main-navigation"
          onClick={() => setMenuOpen((value) => !value)}
        >
          <span aria-hidden="true">{menuOpen ? '×' : '☰'}</span> {menuOpen ? 'Cerrar' : 'Menú'}
        </button>
        <nav
          id="main-navigation"
          className={`has-indicator ${menuOpen ? 'is-open' : ''}`}
          aria-label="Navegación principal"
        >
          {links
            .filter(([id]) => id !== 'cuenta')
            .map(([id, label]) => (
              <a
                key={id}
                href={'#' + id}
                onClick={() => setMenuOpen(false)}
                aria-current={
                  page === id && !(id === 'inicio' && hash === '#como') ? 'page' : undefined
                }
                className={id === 'agenda' ? 'nav-cta' : undefined}
              >
                {label}
              </a>
            ))}
          <SlidingIndicator
            selector="a[aria-current]:not(.nav-cta)"
            watch={`${page}${hash}${menuOpen}`}
          />
        </nav>
        <AccountMenu
          active={page === 'cuenta' || page === 'ajustes'}
          onNavigate={() => setMenuOpen(false)}
        />
      </header>
      <main key={page} id="contenido" ref={main} tabIndex={-1} className="page-content">
        {page === 'contacto' && <Contact />}
        {page === 'inicio' && <Home />}
        {page === 'servicios' && <Services />}
        {page === 'agenda' && <Calendar />}
        {page === 'cuenta' && <AccountDashboard />}
        {page === 'ajustes' && <AccountSettings />}
        {page === 'garantia' && <WarrantyPolicy />}
        {page === 'solicitud' && <HelpRequest />}
      </main>
      <footer>
        <span>© 2026 InstaFix. Todos los derechos reservados.</span>
        <span>Servicios a domicilio.</span>
        <div className="footer-links">
          <a className="footer-policy" href="#contacto">
            Contacto
          </a>
          <a className="footer-policy" href="#garantia">
            Políticas de garantía
          </a>
        </div>
        {INSTAGRAM_URL && (
          <a
            className="footer-social"
            href={INSTAGRAM_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Instafix en Instagram (se abre en otra pestaña)"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              aria-hidden="true"
            >
              <rect x="3" y="3" width="18" height="18" rx="5" />
              <circle cx="12" cy="12" r="4" />
              <circle cx="17.3" cy="6.7" r="0.9" fill="currentColor" stroke="none" />
            </svg>
            <span>Instagram</span>
          </a>
        )}
      </footer>
      <a
        className="mobile-booking"
        href="#agenda"
        aria-label="Agendar una cita"
        aria-current={page === 'agenda' ? 'page' : undefined}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          aria-hidden="true"
        >
          <rect x="3" y="5" width="18" height="16" rx="3" />
          <path d="M7 3v4m10-4v4M3 11h18m-9 3v4m-2-2h4" strokeLinecap="round" />
        </svg>
        <span>Agendar cita</span>
      </a>
    </>
  );
}
