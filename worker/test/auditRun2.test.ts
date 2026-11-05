/**
 * Regressions for the security audit run-2 findings (~/security-audit-skill/ChampBeam/run-2):
 * platform-served hosts cannot be claimed as custom domains, and a removed or viewer-demoted owner
 * cannot keep editing content that sits on the org's domain.
 */
import { expect, it } from "vitest";
import { api, env, json } from "./helpers";
import { member, newOrgId, setSettings, useRouteTestHooks } from "./orgTestUtils";
import { seedFile } from "./serveSeed";

useRouteTestHooks();

const q = (sql: string, ...b: unknown[]) => env.DB.prepare(sql).bind(...b).first<Record<string, any>>();
const HTML = "<!doctype html><html><head><title>T</title></head><body>hi</body></html>";

it("the app host, its www twin, the subdomain base, reserved labels and workers.dev cannot be claimed", async () => {
  setSettings({ frontendUrl: "https://app.reserve.test", platformSubdomainBase: "reserve.test" });
  const admin = await member(newOrgId(), "admin");
  const claim = (hostname: string) => api("/api/v1/domains", { method: "POST", json: { hostname }, headers: admin.headers });
  for (const h of ["app.reserve.test", "www.app.reserve.test", "reserve.test", "www.reserve.test", "api.reserve.test", "champbeam.acct.workers.dev"]) {
    const r = await claim(h);
    expect(r.status, h).toBe(400);
  }
  expect((await claim(`t-${crypto.randomUUID().slice(0, 6)}.reserve.test`)).status).toBe(201);
});

async function orgPage() {
  setSettings({ platformSubdomainBase: "edit.test" });
  const clerkOrg = newOrgId();
  const admin = await member(clerkOrg, "admin");
  const rep = await member(clerkOrg, "member");
  const org = (await q("SELECT id FROM organizations WHERE clerk_org_id = ?", clerkOrg))!.id as string;
  const d = await json(await api("/api/v1/domains", { method: "POST", json: { hostname: `d-${crypto.randomUUID().slice(0, 6)}.edit.test` }, headers: admin.headers }));
  expect((await api(`/api/v1/org/domains/${d.id}/attach`, { method: "POST", headers: admin.headers })).status).toBe(200);
  const r = await api("/api/v1/pages", { method: "POST", json: { html: HTML, title: "Org Page", domain_id: d.id }, headers: rep.headers });
  expect(r.status, await r.clone().text()).toBe(201);
  return { org, rep, domainId: d.id as string, page: await json(r) };
}

const setMember = (org: string, userId: string, sql: string) =>
  env.DB.prepare(`UPDATE organization_memberships SET ${sql} WHERE organization_id = ? AND user_id = ?`).bind(org, userId).run();

it("a current member edits their page on the org domain; once removed or made a viewer they cannot", async () => {
  const s = await orgPage();
  const patch = () => api(`/api/v1/pages/${s.page.page_id}`, { method: "PATCH", json: { title: "Renamed" }, headers: s.rep.headers });
  const put = () => api(`/api/v1/pages/${s.page.page_id}`, { method: "PUT", json: { html: HTML.replace("hi", "edited") }, headers: s.rep.headers });
  expect((await patch()).status).toBe(200);

  await setMember(s.org, s.rep.userId, "clerk_membership_id = 'mem_v', role = 'viewer'");
  expect((await patch()).status).toBe(403);
  expect((await put()).status).toBe(403);

  await setMember(s.org, s.rep.userId, "role = 'member', status = 'revoked'");
  expect((await patch()).status).toBe(403);
  expect((await put()).status).toBe(403);
  // A file on the org domain is held to the same rule.
  const f = await seedFile(s.rep.userId, { domain_id: s.domainId });
  expect((await api(`/api/v1/files/${f.id}/access`, { method: "PUT", json: { max_views: 3 }, headers: s.rep.headers })).status).toBe(403);
});

it("a shared UTM preset is listed to the owner's org, not to other tenants", async () => {
  const clerkOrg = newOrgId();
  const owner = await member(clerkOrg, "member");
  const mate = await member(clerkOrg, "member");
  const outsider = await member(newOrgId(), "member");
  const name = `Shared ${crypto.randomUUID().slice(0, 6)}`;
  expect((await api("/api/v1/utm/presets", { method: "POST", json: { name, is_shared: true }, headers: owner.headers })).status).toBe(201);
  const names = async (h: Record<string, string>) => (await json<any[]>(await api("/api/v1/utm/presets", { headers: h }))).map((p) => p.name);
  expect(await names(mate.headers)).toContain(name);
  expect(await names(outsider.headers)).not.toContain(name);
});
