import {
  getCountries,
  getCountryCallingCode,
  type CountryCode,
} from '@instafix/contracts/src/phone';

const names = new Intl.DisplayNames(['es'], { type: 'region' });
const countries = getCountries().sort((a, b) =>
  (names.of(a) ?? a).localeCompare(names.of(b) ?? b, 'es'),
);
const flag = (country: string) =>
  [...country].map((letter) => String.fromCodePoint(127397 + letter.charCodeAt(0))).join('');

/** Número de WhatsApp con país. El backend hace la normalización definitiva a E.164. */
export function PhoneField({
  id,
  label = 'WhatsApp',
  country,
  onCountry,
  autoComplete = 'tel-national',
  defaultValue,
}: {
  id: string;
  label?: string;
  country: CountryCode;
  onCountry: (country: CountryCode) => void;
  autoComplete?: string;
  defaultValue?: string;
}) {
  return (
    <div className="auth-phone-field">
      <label htmlFor={id}>{label}</label>
      <div className="auth-phone-control">
        <div className="auth-country">
          <span aria-hidden="true">
            {flag(country)} +{getCountryCallingCode(country)}{' '}
            <span className="auth-country-chevron">⌄</span>
          </span>
          <select
            aria-label="País y código"
            value={country}
            onChange={(e) => onCountry(e.target.value as CountryCode)}
            autoComplete="tel-country-code"
          >
            {countries.map((code) => (
              <option key={code} value={code}>
                {flag(code)} {names.of(code)} (+{getCountryCallingCode(code)})
              </option>
            ))}
          </select>
        </div>
        <input
          id={id}
          name="phone"
          type="tel"
          inputMode="tel"
          autoComplete={autoComplete}
          placeholder="987654321"
          required
          maxLength={30}
          defaultValue={defaultValue}
        />
      </div>
    </div>
  );
}
