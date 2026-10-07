import { useEffect, useRef, useState } from 'react';
import { Brand } from '../components/layout/Brand';
import { About } from '../features/about/About';
import { AccountDashboard } from '../features/account/AccountDashboard';
import { Calendar } from '../features/booking/Calendar';
import { Services } from '../features/catalog/Services';
import { HelpRequest } from '../features/help/HelpRequest';
import { Home } from '../features/home/Home';
import { HowItWorks } from '../features/how-it-works/HowItWorks';
import { WarrantyPolicy } from '../features/warranty/WarrantyPolicy';
import { resolvePage } from './navigation';
const links = [
  ['inicio', 'Inicio'],
  ['servicios', 'Servicios'],
  ['quienes-somos', 'Quiénes somos'],
  ['como', 'Cómo funciona'],
  ['cuenta', 'Mi cuenta'],
  ['agenda', 'Agendar cita'],
] as const;
export function App() {
  const [page, setPage] = useState(() => resolvePage(window.location.hash));
  const main = useRef<HTMLElement>(null);
  useEffect(() => {
    const navigate = () => setPage(resolvePage(window.location.hash));
    window.addEventListener('hashchange', navigate);
    return () => window.removeEventListener('hashchange', navigate);
  }, []);
  useEffect(() => {
    document.title =
      (links.find(([id]) => id === page)?.[1] ??
        (page === 'garantia' ? 'Políticas de garantía' : 'Asesoría')) + ' · InstaFix';
    window.scrollTo({ top: 0, behavior: 'instant' });
    main.current?.focus({ preventScroll: true });
    if (window.location.hash === '#nuestro-trabajo')
      document.getElementById('nuestro-trabajo')?.scrollIntoView();
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
      <header>
        <Brand />
        <nav aria-label="Navegación principal">
          {links.map(([id, label]) => (
            <a
              key={id}
              href={'#' + id}
              aria-current={page === id ? 'page' : undefined}
              className={id === 'agenda' ? 'nav-cta' : undefined}
            >
              {label}
            </a>
          ))}
        </nav>
      </header>
      <main key={page} id="contenido" ref={main} tabIndex={-1} className="page-content">
        {page === 'inicio' && <Home />}
        {page === 'servicios' && <Services />}
        {page === 'quienes-somos' && <About />}
        {page === 'agenda' && <Calendar />}
        {page === 'cuenta' && <AccountDashboard />}
        {page === 'garantia' && <WarrantyPolicy />}
        {page === 'solicitud' && <HelpRequest />}
        {page === 'como' && <HowItWorks />}
      </main>
      <footer>
        <Brand />
        <span>Tecnología que sigue contigo.</span>
        <a className="footer-policy" href="#garantia">
          Políticas de garantía
        </a>
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
