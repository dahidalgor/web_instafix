import {
  getCountries,
  getCountryCallingCode,
  parsePhoneNumberFromString,
  type CountryCode,
} from 'libphonenumber-js';
export { getCountries, getCountryCallingCode, type CountryCode };
export function normalizePhone(value: string, country: CountryCode): string | null {
  const parsed = parsePhoneNumberFromString(value, country);
  return parsed?.isValid() ? parsed.number : null;
}

/** Muestra solo prefijo, operador y últimos dígitos: +593 98 *** **19. */
export function maskPhone(value: string): string {
  const parsed = parsePhoneNumberFromString(value);
  if (!parsed) return '••••';
  const international = parsed.formatInternational();
  const prefix = `+${parsed.countryCallingCode} `;
  const national = international.slice(prefix.length);
  const digits = national.replace(/\D/g, '');
  let seen = 0;
  const masked = national.replace(/\d/g, (digit) => {
    seen++;
    return seen <= 2 || seen > digits.length - 2 ? digit : '*';
  });
  return prefix + masked;
}
