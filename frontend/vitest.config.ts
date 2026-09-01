import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Vitest runs the unit/component tests (jsdom). It is deliberately separate from
// vite.config.ts so the Tailwind plugin doesn't run during tests. E2E lives
// under e2e/ and is driven by Playwright, not Vitest.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/storage-polyfill.ts', './src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
  },
});
