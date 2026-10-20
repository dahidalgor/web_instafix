import { HowItWorks } from '../how-it-works/HowItWorks';
import { WorkShowcase } from './WorkShowcase';

const values = [
  {
    title: 'Cerca de ti',
    text: 'Atención a domicilio para que no tengas que trasladar tu equipo.',
  },
  {
    title: 'Hablemos claro',
    text: 'Queremos que entiendas el servicio que necesitas y su alcance antes de empezar.',
  },
  {
    title: 'Tu equipo importa',
    text: 'Mantenimiento y reparación para seguir aprovechando la tecnología que ya tienes.',
  },
];

/**
 * Inicio: presentación de Instafix → nuestro trabajo → cómo funciona → agendar.
 * Reúne las antiguas páginas «Quiénes somos» y «Cómo funciona» en un solo recorrido.
 */
export function Home() {
  return (
    <div className="home">
      <section id="quienes-somos" className="hero home-hero" aria-labelledby="home-title">
        <p className="eyebrow">INSTAFIX · SERVICIO TÉCNICO A DOMICILIO</p>
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
          <div className="home-hero-actions">
            <a className="button" href="#agenda">
              Agendar visita <span aria-hidden="true">↗</span>
            </a>
            <a className="text-button" href="#servicios">
              Ver servicios y precios →
            </a>
          </div>
        </div>
        <ul className="home-values" aria-label="Por qué Instafix">
          {values.map((value, index) => (
            <li key={value.title}>
              <span aria-hidden="true">0{index + 1}</span>
              <h2>{value.title}</h2>
              <p>{value.text}</p>
            </li>
          ))}
        </ul>
      </section>
      <WorkShowcase />
      <HowItWorks />
    </div>
  );
}
