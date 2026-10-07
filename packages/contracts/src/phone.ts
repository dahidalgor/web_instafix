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
