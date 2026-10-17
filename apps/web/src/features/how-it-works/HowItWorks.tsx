import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { measureScene, paintScene } from './paint-scene';
import { snapshots, stepAt, steps } from './story';
import { StoryScene } from './StoryScene';

const reducedQuery = '(prefers-reduced-motion: reduce)';

function useReducedMotion() {
  const [reduced, setReduced] = useState(() => window.matchMedia(reducedQuery).matches);
  useEffect(() => {
    const query = window.matchMedia(reducedQuery);
    const change = () => setReduced(query.matches);
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);
  return reduced;
}

/** Escena congelada en un instante de la historia (versión sin movimiento). */
function StillScene({ progress }: { progress: number }) {
  const scene = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = scene.current;
    if (!element) return;
    const paint = () => {
      measureScene(element);
      paintScene(element, progress);
    };
    paint();
    const observer = new ResizeObserver(paint);
    observer.observe(element);
    return () => observer.disconnect();
  }, [progress]);
  return (
    <div className="scene" ref={scene}>
      <StoryScene />
    </div>
  );
}

function ScrollStory() {
  const story = useRef<HTMLDivElement>(null);
  const scene = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);

  useLayoutEffect(() => {
    const wrapper = story.current;
    const element = scene.current;
    if (!wrapper || !element) return;
    let frame = 0;
    let visible = true;
    const update = () => {
      frame = 0;
      const rect = wrapper.getBoundingClientRect();
      const distance = wrapper.offsetHeight - window.innerHeight;
      const progress = distance > 0 ? Math.min(1, Math.max(0, -rect.top / distance)) : 0;
      paintScene(element, progress);
      element.parentElement?.style.setProperty('--progress', progress.toFixed(4));
      setActive(stepAt(progress)); // React ignora el valor si no cambia.
    };
    const schedule = () => {
      if (visible && !frame) frame = requestAnimationFrame(update);
    };
    const resize = () => {
      measureScene(element);
      schedule();
    };
    // Solo se calcula mientras la historia está en pantalla.
    const intersection = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      schedule();
    });
    const size = new ResizeObserver(resize);
    intersection.observe(wrapper);
    size.observe(element);
    measureScene(element);
    update();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', resize);
    return () => {
      cancelAnimationFrame(frame);
      intersection.disconnect();
      size.disconnect();
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', resize);
    };
  }, []);

  const jumpTo = (progress: number) => {
    const wrapper = story.current;
    if (!wrapper) return;
    const top = wrapper.getBoundingClientRect().top + window.scrollY;
    const distance = wrapper.offsetHeight - window.innerHeight;
    window.scrollTo({ top: top + distance * progress, behavior: 'smooth' });
  };

  return (
    <div className="story" ref={story}>
      <div className="story-stage">
        <div className="story-copy">
          <p className="eyebrow story-eyebrow">TÚ AGENDAS. NOSOTROS VAMOS.</p>
          <div className="story-meter" aria-hidden="true">
            {steps.map((step, index) => (
              <span key={step.label} className={index <= active ? 'is-on' : undefined}>
                <i />
                {step.label}
              </span>
            ))}
          </div>
          <ol className="story-steps">
            {steps.map((step, index) => (
              <li
                key={step.title}
                className={`story-step ${index === active ? 'is-active' : ''} ${index < active ? 'is-done' : ''}`}
              >
                <button
                  type="button"
                  aria-current={index === active ? 'step' : undefined}
                  onClick={() => jumpTo(step.jump)}
                >
                  <span className="story-number" aria-hidden="true">
                    0{index + 1}
                  </span>
                  <span className="story-title">{step.title}</span>
                </button>
                <p>{step.text}</p>
              </li>
            ))}
          </ol>
          <a className="button story-cta" href="#agenda">
            Agendar visita <span aria-hidden="true">↗</span>
          </a>
        </div>
        <div className="scene" ref={scene}>
          <StoryScene />
          <span className="scroll-cue" aria-hidden="true">
            Desliza para ver el recorrido
          </span>
        </div>
      </div>
    </div>
  );
}

export function HowItWorks() {
  const reduced = useReducedMotion();
  return (
    <section className="how-page" aria-labelledby="how-title">
      <div className="journey-heading">
        <p className="eyebrow">CÓMO FUNCIONA</p>
        <h1 id="how-title">
          Tú agendas.
          <br />
          <em>Nosotros vamos.</em>
        </h1>
        <p className="intro">
          Servicio técnico a domicilio para tu consola o computadora. Sin cargar tu equipo hasta un
          local.
        </p>
      </div>
      {reduced ? (
        <ol className="story-static">
          {steps.map((step, index) => (
            <li key={step.title}>
              <StillScene progress={snapshots[index]} />
              <p className="eyebrow">PASO 0{index + 1}</p>
              <h2>{step.title}</h2>
              <p>{step.text}</p>
            </li>
          ))}
        </ol>
      ) : (
        <ScrollStory />
      )}
      <div className="journey-end">
        <h2>
          Tu equipo, atendido <em>en casa.</em>
        </h2>
        <p>Elige el día y la hora. Del resto nos encargamos nosotros.</p>
        <div className="journey-actions">
          <a className="button" href="#agenda">
            Agendar visita <span aria-hidden="true">↗</span>
          </a>
          <a className="text-button" href="#servicios">
            Ver servicios y precios
          </a>
        </div>
        <p className="small">
          ¿No sabes qué necesita tu equipo? <a href="#solicitud">Te ayudamos a elegir →</a>
        </p>
      </div>
    </section>
  );
}
