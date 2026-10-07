import { useEffect, useState } from 'react';
import { slides } from './slides';

export function About() {
  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (
      !playing ||
      hovered ||
      focused ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    )
      return;
    const timer = window.setInterval(
      () => setCurrent((value) => (value + 1) % slides.length),
      6500,
    );
    return () => window.clearInterval(timer);
  }, [playing, hovered, focused]);
  function change(index: number) {
    setPlaying(false);
    setCurrent((index + slides.length) % slides.length);
  }
  const slide = slides[current];
  return (
    <div className="about-page">
      <section className="about-intro" aria-labelledby="about-title">
        <p className="eyebrow">CONOCE INSTAFIX</p>
        <h1 id="about-title">
          Detrás de cada equipo,
          <br />
          hay algo que <em>te importa.</em>
        </h1>
        <div className="about-intro-bottom">
          <p>
            Una partida pendiente. Un proyecto por terminar. Tu herramienta de todos los días. En
            Instafix queremos que un problema técnico no te aleje de lo que disfrutas.
          </p>
          <a href="#nuestro-trabajo" className="about-jump">
            Conoce lo que hacemos <span>↓</span>
          </a>
        </div>
      </section>
      <section
        id="nuestro-trabajo"
        className="work-showcase"
        aria-label="Presentación de nuestros servicios"
        aria-roledescription="carrusel"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocusCapture={() => setFocused(true)}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
        }}
      >
        <div className={'work-visual work-visual-' + current}>
          {slide.image ? (
            <img src={slide.image} alt={slide.title} />
          ) : (
            <>
              <div className="work-grid" />
              <div className="work-orbit" />
              <span className="work-symbol" aria-hidden="true">
                {slide.symbol}
              </span>
              <span className="work-placeholder">
                Ilustración · Fotos de nuestros trabajos próximamente
              </span>
            </>
          )}
          <span className="work-overline">INSTAFIX / EN ACCIÓN</span>
          <span className="work-detail">{slide.detail}</span>
        </div>
        <div className="work-story">
          <div className="work-heading">
            <span className="eyebrow">LO QUE HACEMOS</span>
            <span className="work-count">0{current + 1} / 03</span>
          </div>
          <div className="work-copy" aria-live={playing ? 'off' : 'polite'} aria-atomic="true">
            <p className="work-category">{slide.label}</p>
            <h2>{slide.title}</h2>
            <p>{slide.description}</p>
          </div>
          <div className="work-controls">
            <div className="work-dots">
              {slides.map((item, index) => (
                <button
                  key={item.label}
                  aria-label={'Ver ' + item.label.toLowerCase()}
                  aria-pressed={index === current}
                  className={index === current ? 'selected' : ''}
                  onClick={() => change(index)}
                />
              ))}
            </div>
            <div className="work-arrows">
              <button aria-label="Diapositiva anterior" onClick={() => change(current - 1)}>
                ←
              </button>
              <button aria-label="Diapositiva siguiente" onClick={() => change(current + 1)}>
                →
              </button>
            </div>
          </div>
          <button className="work-play" onClick={() => setPlaying((value) => !value)}>
            {playing ? 'Ⅱ Pausar presentación' : '▷ Reproducir presentación'}
          </button>
        </div>
      </section>
      <section className="about-purpose">
        <div>
          <p className="eyebrow">TECNOLOGÍA CON TRATO HUMANO</p>
          <h2>
            El servicio técnico
            <br />
            debería ser <em>más sencillo.</em>
          </h2>
        </div>
        <div>
          <p>
            Somos Instafix, un servicio de mantenimiento y reparación de consolas, PCs, laptops y
            hardware a domicilio.
          </p>
          <p>
            Estamos construyendo una plataforma para que puedas encontrar al técnico adecuado,
            conocer su oferta y coordinar la atención de tu equipo desde un mismo lugar.
          </p>
        </div>
      </section>
      <section className="about-values" aria-label="Nuestra forma de trabajar">
        {[
          {
            number: '01',
            title: 'Cerca de ti',
            text: 'Atención a domicilio para que no tengas que trasladar tu equipo.',
          },
          {
            number: '02',
            title: 'Hablemos claro',
            text: 'Queremos que entiendas el servicio que necesitas y su alcance antes de empezar.',
          },
          {
            number: '03',
            title: 'Tu equipo importa',
            text: 'Mantenimiento y reparación para seguir aprovechando la tecnología que ya tienes.',
          },
        ].map((value) => (
          <article key={value.number}>
            <span>{value.number}</span>
            <h3>{value.title}</h3>
            <p>{value.text}</p>
          </article>
        ))}
      </section>
      <section className="about-cta">
        <div>
          <p className="eyebrow">SIGAMOS CONECTADOS</p>
          <h2>
            Tu equipo tiene mucho
            <br />
            por hacer todavía.
          </h2>
        </div>
        <a className="button" href="#servicios">
          Encuentra tu servicio <span>↗</span>
        </a>
      </section>
    </div>
  );
}
