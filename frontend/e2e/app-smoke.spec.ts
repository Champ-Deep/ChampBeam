import { test, expect } from '@playwright/test';

// Frontend smoke against a deployed origin (E2E_BASE_URL). Covers the login loop
// regression, page stability (no stutter/reload storms), and the theme token
// system in a real browser. Maps to docs/TESTING.md § Login / Performance /
// Themes. Authenticated flows live in authed.spec.ts.
const BASE = process.env.E2E_BASE_URL;

test.describe('app smoke (public)', () => {
  test.skip(!BASE, 'Set E2E_BASE_URL to the frontend origin to run.');

  test('LOGIN-1 protected route redirects to sign-in and stays (no loop)', async ({ page }) => {
    await page.goto('/links', { waitUntil: 'networkidle' });
    // Land on the sign-in route.
    await expect(page).toHaveURL(/\/sign-in/, { timeout: 15_000 });
    const settled = page.url();
    // The login-loop bug manifested as the URL flipping repeatedly. Give it time
    // and assert the location is stable (no bounce back to a protected route or
    // an ever-changing redirect chain).
    await page.waitForTimeout(2500);
    expect(page.url()).toBe(settled);
    // A Clerk sign-in surface is actually rendered (not a blank page).
    await expect(
      page.locator('input[name="identifier"], input[type="email"], form')
    ).toBeVisible({ timeout: 10_000 });
  });

  test('LOGIN-2 landing loads with no uncaught console errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    await page.goto('/', { waitUntil: 'networkidle' });
    await expect(page.locator('body')).toBeVisible();
    // Ignore benign 3rd-party noise; fail on app/runtime errors.
    const appErrors = errors.filter(
      (e) => !/clerk|analytics|favicon|net::ERR|Failed to load resource/i.test(e)
    );
    expect(appErrors, appErrors.join('\n')).toHaveLength(0);
  });

  test('PERF-1 landing does not reload/stutter in a loop', async ({ page }) => {
    let navigations = 0;
    page.on('framenavigated', (f) => {
      if (f === page.mainFrame()) navigations += 1;
    });
    await page.goto('/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(3000);
    // A healthy SPA navigates once (the initial load). A redirect/refresh loop
    // shows up as many main-frame navigations.
    expect(navigations, `main-frame navigations: ${navigations}`).toBeLessThan(4);
  });

  test('THM-E1 first paint is the Paper theme', async ({ page }) => {
    await page.addInitScript(() => localStorage.clear());
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('html')).toHaveAttribute('data-cb-theme', 'paper', {
      timeout: 10_000,
    });
  });

  test('THM-E2 a persisted theme is applied on load', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('champbeam_theme', 'graphite'));
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('html')).toHaveAttribute('data-cb-theme', 'graphite', {
      timeout: 10_000,
    });
    // The accent token actually changed with the theme (Graphite ink vs Paper
    // terracotta), proving the tokens are wired, not just the attribute.
    const accent = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--cb-accent').trim()
    );
    expect(accent.toLowerCase()).toBe('#2f3437');
  });
});
