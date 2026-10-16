export function Contact() {
  return (
    <section className="contact-page" aria-labelledby="contact-title">
      <p className="eyebrow">HABLEMOS DE TU EQUIPO</p>
      <h1 id="contact-title">
        Estamos a un
        <br />
        <em>mensaje de ti.</em>
      </h1>
      <p className="contact-intro">
        Cuéntanos qué le pasa a tu consola o computadora. Te ayudamos a encontrar el siguiente paso.
      </p>
      <div className="contact-options">
        <a
          href="https://wa.me/593984703819"
          target="_blank"
          rel="noreferrer"
          className="contact-card"
        >
          <span className="eyebrow">WHATSAPP</span>
          <h2>Conversemos ↗</h2>
          <p>+593 98 470 3819</p>
          <span>Habla directamente con el equipo de InstaFix.</span>
        </a>
        <a href="#solicitud" className="contact-card">
          <span className="eyebrow">ASESORÍA TÉCNICA</span>
          <h2>Cuéntanos qué sucede →</h2>
          <p>No necesitas una cuenta.</p>
          <span>Deja tu consulta para que podamos orientarte.</span>
        </a>
        <a href="#agenda" className="contact-card">
          <span className="eyebrow">ATENCIÓN A DOMICILIO</span>
          <h2>Encuentra tu horario →</h2>
          <p>Agenda desde nuestra web.</p>
          <span>Coordinamos la ubicación de tu visita por WhatsApp.</span>
        </a>
      </div>
      <p className="small">
        ¿Tienes dudas sobre un trabajo realizado? Consulta <a href="#cuenta">Mi cuenta</a> y
        nuestras <a href="#garantia">políticas de garantía</a>.
      </p>
    </section>
  );
}
