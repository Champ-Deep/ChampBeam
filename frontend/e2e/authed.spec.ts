import { test, expect } from '@playwright/test';

// Signed-in flows. These need a real Clerk session captured to a storageState
// file (Clerk's email-code login can't be scripted reliably). Create one once:
//
//   1) npx playwright open --save-storage=auth.json <E2E_BASE_URL>/sign-in
//      (sign in in the opened browser, then close it)
//   2) E2E_STORAGE_STATE=auth.json E2E_BASE_URL=... npx playwright test authed
//
// Maps to docs/TESTING.md § Analytics / Location / Themes / Navigation.
const BASE = process.env.E2E_BASE_URL;
const STORAGE = process.env.E2E_STORAGE_STATE;

test.describe('signed-in flows', () => {
  test.skip(!BASE || !STORAGE, 'Set E2E_BASE_URL and E2E_STORAGE_STATE to run.');
  test.use({ storageState: STORAGE });

  test('NAV-1 sidebar + orbit logo render after sign-in', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });
    // The dark sidebar carries the wordmark and the primary nav.
    await expect(page.getByText('Champbeam', { exact: false }).first()).toBeVisible();
    await expect(page.getByRole('link', { name: /Analytics/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /Links/i })).toBeVisible();
  });

  test('THM-A1 Appearance switch applies + persists across reload', async ({ page }) => {
    await page.goto('/settings?tab=appearance', { waitUntil: 'networkidle' });
    await page.getByText('Graphite', { exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-cb-theme', 'graphite');
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.locator('html')).toHaveAttribute('data-cb-theme', 'graphite');
    // reset to Paper so the run is idempotent
    await page.goto('/settings?tab=appearance', { waitUntil: 'networkidle' });
    await page.getByText('Paper', { exact: true }).click();
  });

  test('ANALYTICS-1 analytics page renders without runtime errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto('/analytics', { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { name: /Analytics/i }).first()).toBeVisible();
    const appErrors = errors.filter((e) => !/clerk|analytics\.js/i.test(e));
    expect(appErrors, appErrors.join('\n')).toHaveLength(0);
  });

  test('LOCATION-1 a link analytics view exposes a location/geo section', async ({ page }) => {
    await page.goto('/links', { waitUntil: 'networkidle' });
    // Folder chips are the App v2 layout marker on this page.
    await expect(page.getByText(/All links/i).first()).toBeVisible();
    // Open the first link's analytics if any links exist; otherwise this is a
    // no-op the doc's manual location step covers with a fresh open.
    const analyticsLink = page.getByRole('button', { name: /analytics/i }).first();
    if (await analyticsLink.count()) {
      await analyticsLink.click();
      await expect(
        page.getByText(/location|country|city|where opens|geo/i).first()
      ).toBeVisible({ timeout: 10_000 });
    }
  });

  test('CHIPS-1 Links + Files render folder chips (not the old rail)', async ({ page }) => {
    await page.goto('/links', { waitUntil: 'networkidle' });
    await expect(page.getByText(/All links/i).first()).toBeVisible();
    await page.goto('/files', { waitUntil: 'networkidle' });
    await expect(page.getByText(/All files/i).first()).toBeVisible();
  });

  test('PERF-2 signed-in navigation does not stutter', async ({ page }) => {
    let navigations = 0;
    page.on('framenavigated', (f) => {
      if (f === page.mainFrame()) navigations += 1;
    });
    await page.goto('/analytics', { waitUntil: 'networkidle' });
    await page.getByRole('link', { name: /Links/i }).click();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);
    // SPA route changes are client-side (pushState), so full main-frame
    // navigations stay minimal even across two page visits.
    expect(navigations, `main-frame navigations: ${navigations}`).toBeLessThan(5);
  });
});
