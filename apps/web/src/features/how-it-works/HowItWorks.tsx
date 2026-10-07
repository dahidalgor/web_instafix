import { useEffect, useRef, useState } from 'react';
import { StepArt } from './StepArt';
import { steps } from './steps';

export function HowItWorks() {
  const root = useRef<HTMLElement>(null);
  const [active, setActive] = useState(0);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const cards = Array.from(element.querySelectorAll<HTMLElement>('.journey-step'));
      const anchor = window.innerHeight * 0.55;
      let nearest = 0;
      let distance = Infinity;
      cards.forEach((card, index) => {
        const rect = card.getBoundingClientRect();
        const value = Math.abs(rect.top + rect.height / 2 - anchor);
        if (value < distance) {
          nearest = index;
          distance = value;
        }
        if (rect.top < window.innerHeight * 0.92) card.classList.add('is-revealed');
      });
      setActive(nearest);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, []);
  return (
    <section className="how-page" ref={root}>
      <div className="journey-heading">
        <p className="eyebrow">ASÍ DE SENCILLO</p>
        <h1>
          Tu equipo listo.
          <br />
          <em>Sin salir de casa.</em>
        </h1>
        <p className="intro">Cuatro pasos para volver a disfrutar de lo que te conecta.</p>
      </div>
      <div className="journey-layout">
        <aside className="journey-guide" aria-label="Pasos de la atención">
          <span className="eyebrow">DE TU PANTALLA A TU PUERTA</span>
          <div className="journey-counter" aria-hidden="true">
            0{active + 1}
            <span> / 04</span>
          </div>
          <div className="journey-progress" aria-hidden="true">
            <span className={`journey-progress-step-${active + 1}`} />
          </div>
          <nav aria-label="Pasos del servicio">
            {steps.map((step, index) => (
              <a
                key={step[0]}
                href={`#paso-${index + 1}`}
                aria-current={active === index ? 'step' : undefined}
                onClick={(event) => {
                  event.preventDefault();
                  document.getElementById(`paso-${index + 1}`)?.scrollIntoView({
                    behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
                      ? 'instant'
                      : 'smooth',
                    block: 'center',
                  });
                }}
              >
                <span>0{index + 1}</span>
                {['Elige', 'Agenda', 'Comparte', 'Recibe'][index]}
              </a>
            ))}
          </nav>
        </aside>
        <ol className="journey-steps">
          {steps.map(([title, text, cta, href], index) => (
            <li
              id={`paso-${index + 1}`}
              key={title}
              className={`journey-step ${active === index ? 'is-current' : ''}`}
            >
              <div className="journey-art">
                <StepArt index={index} />
                <span className="journey-number" aria-hidden="true">
                  0{index + 1}
                </span>
              </div>
              <div className="journey-copy">
                <p className="eyebrow">PASO 0{index + 1}</p>
                <h2>{title}</h2>
                <p>{text}</p>
                {cta && (
                  <a className="text-button" href={href}>
                    {cta} ↗
                  </a>
                )}
              </div>
            </li>
          ))}
        </ol>
      </div>
      <div className="journey-end">
        <p>¿No sabes qué necesita tu equipo?</p>
        <a className="button" href="#solicitud">
          Te ayudamos a elegir ↗
        </a>
      </div>
    </section>
  );
}
