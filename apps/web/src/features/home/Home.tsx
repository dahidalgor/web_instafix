export function Home() {
  return (
    <section className="hero">
      <div>
        <p className="eyebrow">SERVICIO TÉCNICO A DOMICILIO</p>
        <h1>
          Tu tecnología.
          <br />
          En buenas <em>manos.</em>
        </h1>
        <p className="intro">
          Dale una nueva vida a tu consola o computadora. El cuidado que necesita, sin salir de
          casa.
        </p>
        <a className="button" href="#servicios">
          Encuentra tu servicio <span>↗</span>
        </a>
        <p className="small">Sin crear una cuenta · Coordinación por WhatsApp</p>
        <a className="text-button" href="#quienes-somos">
          Conoce Instafix →
        </a>
      </div>
      <div className="hero-art" aria-hidden="true">
        <div className="orbit" />
        <div className="device">
          <div className="screen">
            i<span>↗</span>
          </div>
          <div className="base" />
        </div>
        <div className="art-tag">✦ Cuidamos lo que te conecta</div>
        <div className="chip">PC + CONSOLAS</div>
      </div>
    </section>
  );
}
