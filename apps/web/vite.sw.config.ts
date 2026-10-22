import { defineConfig } from 'vite';

/**
 * Service worker como archivo único y clásico en dist/sw.js (sin `import`, sin hash): iOS y
 * los demás navegadores lo registran en `/sw.js` con alcance `/`. Se construye después de la
 * web sin borrar dist.
 */
export default defineConfig({
  build: {
    emptyOutDir: false,
    copyPublicDir: false,
    lib: {
      entry: 'src/sw/sw.ts',
      formats: ['iife'],
      name: 'InstafixServiceWorker',
      fileName: () => 'sw.js',
    },
  },
});
