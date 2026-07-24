import { defineConfig, devices } from '@playwright/test';

// E2E targets a DEPLOYED instance (Railway backend + Vercel frontend) or a local
// preview — never a mock. Point it with env vars:
//   E2E_BASE_URL   frontend origin, e.g. https://app.champbeam.com
//   E2E_API_URL    backend API base, e.g. https://<railway-app>/api/v1
//   E2E_STORAGE_STATE  (optional) path to a Playwright storageState JSON that
//                      carries a signed-in Clerk session, to run authed specs.
// Tests self-skip when the var they need is unset, so a bare `playwright test`
// never fails for missing config — it reports what it could and couldn't run.
const baseURL = process.env.E2E_BASE_URL || undefined;

// Use the environment's pre-installed Chromium (no download). The symlink
// resolves to the chrome binary; override with PLAYWRIGHT_CHROMIUM if needed.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM || '/opt/pw-browsers/chromium';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], launchOptions: { executablePath } },
    },
  ],
});
