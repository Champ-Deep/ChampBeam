/**
 * POST /api/v1/domains/purchase spends the operator's registrar money: org admins only, capped per org per day.
 * The Cloudflare Registrar is mocked at fetch (no network).
 */
import { expect, it, vi } from "vitest";
import { api, authedUser, env } from "./helpers";
import { member, setSettings, useRouteTestHooks } from "./orgTestUtils";
import { DOMAIN_PURCHASES_PER_DAY } from "../src/routes/domains";

useRouteTestHooks();

function mockRegistrar() {
  const paid: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if ((init?.method ?? "GET").toUpperCase() === "POST" && url.endsWith("/registrar/registrations")) paid.push(url);
    return Response.json({ success: true, result: { state: "succeeded", completed: true, context: { registration: { status: "active", price: 9.77 } } } });
  });
  return paid;
}

const buy = (domain: string, headers: Record<string, string>) =>
  api("/api/v1/domains/purchase", { method: "POST", json: { domain, auto_renew: false }, headers });

it("only org admins can buy, and an org is capped per day", async () => {
  setSettings({ cloudflareApiToken: "cf-token", cloudflareAccountId: "acct-t", cloudflareRegistrarConfigured: true, cloudflareConfigured: false, cloudflareCnameTarget: "", cloudflareRegistrantEmail: "" });
  const paid = mockRegistrar();
  const org = `org_${crypto.randomUUID().slice(0, 8)}`;
  for (const role of ["viewer", "member", "leader"]) {
    expect((await buy(`no-${role}-${crypto.randomUUID().slice(0, 6)}.com`, (await member(org, role)).headers)).status).toBe(403);
  }
  expect((await buy(`no-key-${crypto.randomUUID().slice(0, 6)}.com`, (await authedUser()).headers)).status).toBe(403);
  expect(paid.length).toBe(0);

  const admin = await member(org, "admin");
  for (let i = 0; i < DOMAIN_PURCHASES_PER_DAY; i++) expect((await buy(`ok-${i}-${crypto.randomUUID().slice(0, 6)}.com`, admin.headers)).status).toBe(201);
  const over = await buy(`over-${crypto.randomUUID().slice(0, 6)}.com`, (await member(org, "admin")).headers);
  expect(over.status).toBe(429);
  expect(paid.length).toBe(DOMAIN_PURCHASES_PER_DAY);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM domains WHERE registrar = 'cloudflare_registrar' AND hostname LIKE 'track.ok-%'").first<{ n: number }>())!.n).toBe(DOMAIN_PURCHASES_PER_DAY);
});
