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

/** "+593 98 *** **19": suficiente para reconocer el número sin exponerlo completo. */
export function maskPhone(value: string): string {
  const parsed = parsePhoneNumberFromString(value);
  if (!parsed) return '***';
  const national = String(parsed.nationalNumber);
  return `+${parsed.countryCallingCode} ${national.slice(0, 2)} *** **${national.slice(-2)}`;
}

export function maskEmail(value: string): string {
  const [local, domain] = value.split('@');
  if (!local || !domain) return '***';
  return `${local[0]}***@${domain}`;
}
