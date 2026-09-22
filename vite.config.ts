import { defineConfig } from 'vite';

// Served into a MakeCode iframe, so: a fixed port (the targetconfig devUrl
// names it) and relative asset paths (the published build is loaded from a
// GitHub Pages subpath, not from a domain root).
//
// 3400, not 3000. The campus dev setup already points PUBLIC_PYEDITOR_BASE_URL
// at localhost:3000, so the two servers cannot both be up — and the symptom is
// not an error but a panel that silently shows the Python editor, or a port
// that is simply taken. `strictPort` makes that collision loud instead of
// letting vite drift to another port the targetconfig does not name.
export default defineConfig({
  base: './',
  server: { port: 3400, strictPort: true }
});
