import { defineConfig } from 'vite';
export default defineConfig({
  resolve: { dedupe: ['react', 'react-dom'] },
  server: { allowedHosts: ['admin.localhost'], proxy: { '/api': 'http://127.0.0.1:3001' } },
});
