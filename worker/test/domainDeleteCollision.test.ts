/**
 * Deleting a custom domain moves its pages/links into the platform namespace (FK SET NULL). A code that already
 * exists there must be refused with 409 BEFORE the Cloudflare hostname is destroyed, not 500 after it.
 */
import { expect, it, vi } from "vitest";
import { api, authedUser, env, json } from "./helpers";
import { setSettings, useRouteTestHooks } from "./orgTestUtils";

useRouteTestHooks();
const HTML = "<!doctype html><html><head><title>T</title></head><body><p>hi</p></body></html>";

async function seedDomain(userId: string) {
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO domains (id, user_id, hostname, status, is_primary, created_at, provision_attempts, auto_renew, cf_custom_hostname_id) VALUES (?,?,?,?,0,?,0,0,?)")
    .bind(id, userId, `dc-${id.slice(0, 8)}.example.com`, "active", new Date().toISOString(), "ch_dc").run();
  return id;
}

it("platform slug collision: 409 and the Cloudflare hostname is left alone; no collision: 204", async () => {
  setSettings({ cloudflareApiToken: "cf-token", cloudflareZoneId: "zone1", cloudflareConfigured: true });
  const cf: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    cf.push(`${(init?.method ?? "GET").toUpperCase()} ${typeof input === "string" ? input : input instanceof URL ? input.href : input.url}`);
    return Response.json({ success: true, result: { id: "ch_dc" } });
  });
  const victim = await authedUser();
  const other = await authedUser();
  const domainId = await seedDomain(victim.user.id);
  const slug = `pricing-${crypto.randomUUID().slice(0, 6)}`;
  expect((await api("/api/v1/pages", { method: "POST", json: { html: HTML, title: "t", slug, domain_id: domainId }, headers: victim.headers })).status).toBe(201);
  expect((await api("/api/v1/pages", { method: "POST", json: { html: HTML, title: "t", slug }, headers: other.headers })).status).toBe(201);

  const del = await api(`/api/v1/domains/${domainId}?force=true`, { method: "DELETE", headers: victim.headers });
  expect(del.status).toBe(409);
  expect(cf.filter((x) => x.startsWith("DELETE"))).toEqual([]);
  expect(await env.DB.prepare("SELECT id FROM domains WHERE id = ?").bind(domainId).first()).not.toBeNull();

  const clean = await seedDomain(victim.user.id);
  const p = await json(await api("/api/v1/pages", { method: "POST", json: { html: HTML, title: "t", slug: `${slug}-x`, domain_id: clean }, headers: victim.headers }));
  expect(p.slug).toBeTruthy();
  expect((await api(`/api/v1/domains/${clean}?force=true`, { method: "DELETE", headers: victim.headers })).status).toBe(204);
});
