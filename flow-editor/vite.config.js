import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base: '/flow-editor/' — the built assets are served from that path prefix
// by server/src/app.js's static mount (app.use('/flow-editor', express.
// static(...)), the same pattern already used for /marketing and /admin).
// Without this, Vite's generated index.html would reference root-relative
// /assets/... paths that 404 once actually served under /flow-editor/.
export default defineConfig({
  plugins: [react()],
  base: '/flow-editor/',
  build: {
    outDir: 'dist',
  },
  server: {
    // Local `npm run dev` only — proxies API calls to the real Express app
    // (assumed running on :4000, same convention as every other local
    // verification this session) so the spike can be iterated on without
    // rebuilding, while still hitting the real API and real auth.
    proxy: {
      '/api': 'http://localhost:4000',
    },
  },
});
