import { ScribbleArrow } from '../../components/ui/ScribbleArrow';
import { HowItWorks } from '../how-it-works/HowItWorks';
import { WorkShowcase } from './WorkShowcase';

/**
 * Inicio: presentación de Instafix → nuestro trabajo → cómo funciona → agendar.
 * Reúne las antiguas páginas «Quiénes somos» y «Cómo funciona» en un solo recorrido.
 */
export function Home() {
  return (
    <div className="home">
      <section id="quienes-somos" className="hero home-hero" aria-labelledby="home-title">
        <p className="eyebrow">SERVICIO TÉCNICO A DOMICILIO</p>
        <ScribbleArrow className="arrow-hero" />
        <h1 id="home-title">
          Detrás de cada equipo,
          <br />
          hay algo que <em>te importa.</em>
        </h1>
        <div className="home-hero-bottom">
          <p className="home-hero-lead">
            Una partida pendiente, un proyecto por terminar, tu herramienta de todos los días.
            Instafix da mantenimiento y repara consolas, PCs y laptops en tu domicilio, para que un
            problema técnico no te aleje de lo que disfrutas.
          </p>
        </div>
      </section>
      <WorkShowcase />
      <HowItWorks />
    </div>
  );
}
