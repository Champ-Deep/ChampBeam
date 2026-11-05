import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Local `wrangler dev` (worker/.dev.vars.example). Same origin, so the session cookie and CSRF origin check work.
    proxy: { '/api': 'http://127.0.0.1:8799' },
  },
})
