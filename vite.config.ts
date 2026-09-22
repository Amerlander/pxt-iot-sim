import { defineConfig } from 'vite';

// Served into a MakeCode iframe, so: a fixed port (the targetconfig devUrl
// names it) and relative asset paths (the published build is loaded from a
// GitHub Pages subpath, not from a domain root).
export default defineConfig({
  base: './',
  server: { port: 3000, strictPort: true }
});
