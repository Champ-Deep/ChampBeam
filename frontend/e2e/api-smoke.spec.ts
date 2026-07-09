import { test, expect, request as pwRequest } from '@playwright/test';

// Backend deployment smoke — needs no credentials. Proves the new endpoints are
// actually deployed (200 or an auth challenge, NOT 404) and that geo/company
// intent survived the build. Maps to docs/TESTING.md § API deployment.
const API = process.env.E2E_API_URL; // e.g. https://<railway-app>/api/v1
const ORIGIN = API ? API.replace(/\/api\/v1\/?$/, '') : undefined;

test.describe('API deployment smoke', () => {
  test.skip(!API, 'Set E2E_API_URL to the backend /api/v1 base to run.');

  test('API-1 /health is up', async () => {
    const ctx = await pwRequest.newContext();
    const res = await ctx.get(`${ORIGIN}/health`);
    expect(res.status(), 'health should be 200').toBe(200);
    const body = await res.json().catch(() => ({}));
    expect(body.status ?? 'ok').toBeTruthy();
    await ctx.dispose();
  });

  test('API-2 opens geo endpoint is deployed (auth-gated, not 404)', async () => {
    const ctx = await pwRequest.newContext();
    const res = await ctx.get(`${API}/utm/analytics/geo`);
    // Deployed + protected => 401/403. A 404 means the build is missing this
    // route (the regression we are guarding against).
    expect([200, 401, 403], `got ${res.status()}`).toContain(res.status());
    await ctx.dispose();
  });

  test('API-3 company-intent endpoint is deployed (auth-gated, not 404)', async () => {
    const ctx = await pwRequest.newContext();
    const res = await ctx.get(`${API}/utm/analytics/company-intent`);
    expect([200, 401, 403], `got ${res.status()}`).toContain(res.status());
    await ctx.dispose();
  });

  test('API-4 champvault config responds with a configured flag', async () => {
    const ctx = await pwRequest.newContext();
    const res = await ctx.get(`${API}/champvault/config`);
    expect([200, 401, 403], `got ${res.status()}`).toContain(res.status());
    if (res.status() === 200) {
      const body = await res.json();
      expect(body).toHaveProperty('configured');
      expect(typeof body.configured).toBe('boolean');
    }
    await ctx.dispose();
  });
});
