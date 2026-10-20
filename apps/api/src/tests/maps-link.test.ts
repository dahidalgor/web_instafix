import assert from 'node:assert/strict';
import { test } from 'node:test';
import { locationFromText } from '../whatsapp/maps-link';

// Sin red: los enlaces cortos se expanden con un fetch simulado que imita a Google.
const redirects =
  (map: Record<string, string>): typeof fetch =>
  async (input) => {
    const target = map[String(input)];
    return new Response(
      null,
      target ? { status: 302, headers: { location: target } } : { status: 404 },
    );
  };
const noNetwork: typeof fetch = async () => {
  throw new Error('No debe llamar a la red');
};

test('Google Maps links give the exact pin, the place name or the query coordinates', async () => {
  const place = await locationFromText(
    'Aquí estoy https://www.google.com/maps/place/Parque+La+Carolina/@-0.1803,-78.4855,17z/data=!3m1!4b1!4m6!3m5!1s0x91d59a!8m2!3d-0.1812345!4d-78.4845678!16s',
    noNetwork,
  );
  assert.equal(place?.latitude, -0.1812345);
  assert.equal(place?.longitude, -78.4845678);
  assert.equal(place?.name, 'Parque La Carolina');

  for (const [text, lat, lng] of [
    ['https://maps.google.com/?q=-0.180653,-78.467834', -0.180653, -78.467834],
    ['https://www.google.com/maps/search/?api=1&query=-0.18%2C-78.48', -0.18, -78.48],
    ['https://www.google.com/maps?q=loc:-0.21,-78.49', -0.21, -78.49],
    ['https://www.google.com.ec/maps/@-0.2,-78.5,15z', -0.2, -78.5],
    ['https://www.google.com/maps/dir/?api=1&destination=-2.17,-79.92', -2.17, -79.92],
    ['https://maps.apple.com/?ll=-0.18,-78.48&q=Casa', -0.18, -78.48],
    ['(-0.180653, -78.467834)', -0.180653, -78.467834],
  ] as const) {
    const found = await locationFromText(text, noNetwork);
    assert.equal(found?.latitude, lat, text);
    assert.equal(found?.longitude, lng, text);
  }
});

test('short maps.app.goo.gl links are expanded only through Google over HTTPS', async () => {
  const short = 'https://maps.app.goo.gl/AbC123xyz';
  const expanded = await locationFromText(
    `Mi ubicación: ${short} gracias`,
    redirects({
      [short]:
        'https://www.google.com/maps/place/Casa/@-0.1,-78.4,17z/data=!3d-0.1234567!4d-78.4567891',
    }),
  );
  assert.deepEqual(
    [expanded?.latitude, expanded?.longitude, expanded?.name, expanded?.url],
    [-0.1234567, -78.4567891, 'Casa', short],
  );
  // Página de consentimiento de Google (Europa) con el destino en ?continue=.
  const consent = await locationFromText(
    short,
    redirects({
      [short]: `https://consent.google.com/m?continue=${encodeURIComponent('https://www.google.com/maps?q=-0.3,-78.6')}`,
    }),
  );
  assert.deepEqual([consent?.latitude, consent?.longitude], [-0.3, -78.6]);
  // Redirección fuera de Google: no se sigue; queda el enlace para que el técnico lo abra.
  assert.deepEqual(
    await locationFromText(short, redirects({ [short]: 'https://evil.example/maps?q=1,1' })),
    { url: short },
  );
  assert.deepEqual(await locationFromText(short, noNetwork), { url: short });
});

test('ordinary texts and other links are not locations', async () => {
  for (const text of [
    'Hola, a las 10 está bien',
    '1, 2',
    '10, 20',
    'https://instafix.ec/servicios',
    'https://www.google.com/search?q=-0.18,-78.48',
    'https://maps.google.com.evil.example/?q=-0.18,-78.48',
    '0.000, 0.000',
  ])
    assert.equal(await locationFromText(text, noNetwork), null, text);
});

test('reverse geocoding: street and sector from OpenStreetMap, identified and in Spanish', async () => {
  const { formatArea, reverseGeocode } = await import('../whatsapp/location-area');
  assert.equal(
    formatArea({ road: 'Avenida Amazonas', suburb: 'Iñaquito', city: 'Quito' }),
    'Avenida Amazonas · Iñaquito, Quito',
  );
  assert.equal(formatArea({ neighbourhood: 'La Floresta', city: 'Quito' }), 'La Floresta, Quito');
  assert.equal(formatArea({ road: 'Calle 10', city: 'Guayaquil' }), 'Calle 10 · Guayaquil');
  assert.equal(formatArea({}), null);
  let requested: URL | null = null;
  let agent = '';
  const area = await reverseGeocode(-0.18, -78.48, async (input, init) => {
    requested = new URL(String(input));
    agent = new Headers(init?.headers).get('user-agent') || '';
    return Response.json({
      address: { road: 'Av. 6 de Diciembre', quarter: 'La Mariscal', city: 'Quito' },
    });
  });
  assert.equal(area, 'Av. 6 de Diciembre · La Mariscal, Quito');
  assert.equal(requested!.hostname, 'nominatim.openstreetmap.org');
  assert.equal(requested!.searchParams.get('lat'), '-0.18');
  assert.equal(requested!.searchParams.get('accept-language'), 'es');
  assert.match(agent, /^Instafix\//);
});
