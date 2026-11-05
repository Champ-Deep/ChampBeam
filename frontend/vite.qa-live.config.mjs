import { defineConfig, mergeConfig } from 'vite';
import base from './vite.config.ts';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

// Live QA: the real Worker (wrangler dev, local D1/R2) behind a Clerk stand-in. Never used by npm run build.
const W = 'http://127.0.0.1:8799';
const tokens = JSON.parse(readFileSync(new URL('../.verify/live/tokens.json', import.meta.url)));
export default mergeConfig(base, defineConfig({
  define: { 'import.meta.env.VITE_API_URL': JSON.stringify('/api/v1') },
  resolve: { alias: { '@clerk/react': fileURLToPath(new URL('./qa/live/clerk.jsx', import.meta.url)) } },
  server: { host: '127.0.0.1', port: 3300, strictPort: true,
    proxy: Object.fromEntries(['^/api/', '^/f/', '^/p/', '^/r/', '^/s/'].map((p) => [p, { target: W, changeOrigin: false }])) },
  plugins: [{ name: 'qa-tokens', resolveId: (id) => id === 'virtual:qa-tokens' ? '\0qa-tokens' : null, load: (id) => id === '\0qa-tokens' ? `export default ${JSON.stringify(tokens)}` : null }],
}));
