import { helpRequestSchema, type HelpReceipt } from '@instafix/contracts';
import {
  getCountries,
  getCountryCallingCode,
  normalizePhone,
  type CountryCode,
} from '@instafix/contracts/src/phone';
import { useState, type FormEvent } from 'react';
import { BusyButton } from '../../components/ui/BusyButton';
const names = new Intl.DisplayNames(['es'], { type: 'region' });
const countries = getCountries().sort((a, b) =>
  (names.of(a) ?? a).localeCompare(names.of(b) ?? b, 'es'),
);

export function HelpRequest() {
  const [country, setCountry] = useState<CountryCode>('EC');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState<HelpReceipt | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    const data = new FormData(event.currentTarget);
    const phone = normalizePhone(String(data.get('phone') ?? ''), country);
    if (!phone) {
      setError('Revisa tu número y el país seleccionado.');
      return;
    }
    const parsed = helpRequestSchema.safeParse({
      name: data.get('name'),
      phone,
      device: data.get('device'),
      problem: data.get('problem'),
      consent: data.get('consent') === 'on',
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0].message);
      return;
    }
    setBusy(true);
    try {
      const response = await fetch('/api/v1/help-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed.data),
      });
      if (!response.ok)
        throw new Error(
          'No pudimos guardar tu consulta. Inténtalo de nuevo más tarde; tus datos siguen en el formulario.',
        );
      setReceipt(await response.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo enviar la consulta.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section id="solicitud" className="booking">
      <div>
        <p className="eyebrow">¿NO SABES QUÉ SERVICIO NECESITAS?</p>
        <h2>
          Primero,
          <br />
          <em>te orientamos.</em>
        </h2>
        <p>
          Cuéntanos qué sucede con tu equipo y deja tu contacto para solicitar asesoría de un
          técnico.
        </p>
        <aside>
          <strong>Una consulta, sin reservar una cita</strong>
          <p>
            No necesitas elegir un servicio ni conocer la causa del problema. Describe lo que notas
            y qué equipo tienes.
          </p>
        </aside>
      </div>
      {receipt ? (
        <div className="receipt" role="status">
          <p className="eyebrow">CONSULTA GUARDADA</p>
          <h3>Pendiente de asesoría</h3>
          <p>Referencia: {receipt.reference}</p>
          <p>
            Tu consulta quedó registrada. Aún no se ha asignado un técnico ni enviado un mensaje de
            WhatsApp.
          </p>
          <button onClick={() => setReceipt(null)}>Nueva consulta</button>
        </div>
      ) : (
        <form onSubmit={submit}>
          <label>
            Tu nombre
            <input
              name="name"
              autoComplete="name"
              placeholder="Nombre y apellido"
              required
              minLength={2}
              maxLength={100}
            />
          </label>
          <div className="phone-fields">
            <label>
              País
              <select
                name="country"
                autoComplete="tel-country-code"
                value={country}
                onChange={(event) => setCountry(event.target.value as CountryCode)}
              >
                {countries.map((code) => (
                  <option key={code} value={code}>
                    {names.of(code)} (+{getCountryCallingCode(code)})
                  </option>
                ))}
              </select>
            </label>
            <label>
              Número de WhatsApp
              <input
                name="phone"
                type="tel"
                autoComplete="tel-national"
                placeholder={country === 'EC' ? '099 123 4567' : 'Tu número de teléfono'}
                required
                maxLength={30}
              />
            </label>
          </div>
          <label>
            ¿Qué equipo tienes?
            <input
              name="device"
              placeholder="Por ejemplo: PS5, laptop HP o PC de escritorio"
              required
              minLength={2}
              maxLength={100}
            />
          </label>
          <label>
            ¿En qué podemos ayudarte?
            <textarea
              name="problem"
              placeholder="¿Qué le sucede? ¿Desde cuándo? Cuéntanos tus dudas…"
              required
              minLength={5}
              maxLength={1000}
            />
          </label>
          <label className="check">
            <input name="consent" type="checkbox" required />
            Autorizo que Instafix use mi teléfono para contactarme sobre esta consulta.
          </label>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <BusyButton type="submit" className="button" busy={busy} busyLabel="Enviando consulta…">
            Solicitar asesoría <span>↗</span>
          </BusyButton>
          <p className="small">
            Esta consulta no reserva un horario ni genera un cobro. La atención por técnicos todavía
            está en preparación.
          </p>
        </form>
      )}
    </section>
  );
}
