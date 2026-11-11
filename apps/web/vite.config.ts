import { defineConfig } from 'vite';
export default defineConfig({
  // Fecha de esta versión: se ve en Mi cuenta / Ajustes para saber si un despliegue llegó.
  define: { __BUILD_TIME__: JSON.stringify(new Date().toISOString()) },
  resolve: { dedupe: ['react', 'react-dom'] },
  server: {
    allowedHosts: ['admin.localhost'],
    proxy: { '/api': 'http://127.0.0.1:3001' },
    // Solo desarrollo: el service worker se sirve desde /src/sw/sw.ts con alcance «/».
    headers: { 'Service-Worker-Allowed': '/' },
  },
});
