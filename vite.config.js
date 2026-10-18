import { defineConfig } from 'vite';

// Relative asset paths: the same build is served by the bridge (for testing in
// a browser) and loaded from the installed .ehpk package.
export default defineConfig({
  base: './',
  build: { rollupOptions: { input: { crossbar: 'crossbar.html' } } },
});
