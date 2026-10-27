import { defineConfig } from 'vite';

// `--mode single` builds a one-file web version that loads three.js from a CDN
// (used for shareable test links); the normal build bundles everything.
export default defineConfig(({ mode }) => ({
  base: './',
  build: {
    outDir: mode === 'single' ? 'dist-single' : 'dist',
    target: 'es2020',
    chunkSizeWarningLimit: 800,
    rollupOptions:
      mode === 'single'
        ? {
            external: ['three'],
            output: {
              inlineDynamicImports: true,
              paths: { three: 'https://cdn.jsdelivr.net/npm/three@0.160.1/build/three.module.js' },
            },
          }
        : {},
  },
}));
