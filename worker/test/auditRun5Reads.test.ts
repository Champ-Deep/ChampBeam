/**
 * Audit run-5: a removed or viewer-demoted owner of content on an org domain keeps no read access to the
 * visitor emails and IPs it collected (leads, per-asset events, CSV export, page timeline).
 */
import { expect, it } from "vitest";
import { api, env, json } from "./helpers";
import { member, newOrgId, setSettings, useRouteTestHooks } from "./orgTestUtils";

useRouteTestHooks();

const now = () => new Date().toISOString();

async function setup() {
  setSettings({ platformSubdomainBase: "r5.test" });
  const clerkOrg = newOrgId();
  const admin = await member(clerkOrg, "admin");
  const rep = await member(clerkOrg, "member");
  const org = (await env.DB.prepare("SELECT id FROM organizations WHERE clerk_org_id = ?").bind(clerkOrg).first<{ id: string }>())!.id;
  const d = await json(await api("/api/v1/domains", { method: "POST", json: { hostname: `o-${crypto.randomUUID().slice(0, 6)}.r5.test` }, headers: admin.headers }));
  expect((await api(`/api/v1/org/domains/${d.id}/attach`, { method: "POST", headers: admin.headers })).status).toBe(200);
  const link = await json(await api("/api/v1/utm/generate", { method: "POST", json: { base_url: "https://dest.example/x", domain_id: d.id }, headers: rep.headers }));
  const page = await json(await api("/api/v1/pages", { method: "POST", json: { title: "P", html: "<!doctype html><html><body>hi</body></html>", domain_id: d.id }, headers: rep.headers }));
  await env.DB.prepare("INSERT INTO access_leads (id, link_id, email, ip_address, created_at) VALUES (?,?,?,?,?)").bind(crypto.randomUUID(), link.link_id, "buyer@corp.example", "9.9.9.9", now()).run();
  await env.DB.prepare("INSERT INTO access_leads (id, file_id, email, ip_address, created_at) VALUES (?,?,?,?,?)").bind(crypto.randomUUID(), page.page_id, "pagelead@corp.example", "7.7.7.7", now()).run();
  await env.DB.prepare("INSERT INTO click_events (id, link_id, ip_address, clicked_at, device_type) VALUES (?,?,?,?,?)").bind(crypto.randomUUID(), link.link_id, "9.9.9.9", now(), "desktop").run();
  await env.DB.prepare("INSERT INTO click_events (id, file_id, ip_address, clicked_at, device_type) VALUES (?,?,?,?,?)").bind(crypto.randomUUID(), page.page_id, "8.8.8.8", now(), "desktop").run();
  const paths = [
    `/api/v1/utm/links/${link.link_id}/leads`,
    `/api/v1/utm/analytics/links/${link.link_id}/events`,
    `/api/v1/utm/analytics/export/events`,
    `/api/v1/files/${page.page_id}/leads`,
    `/api/v1/files/${page.page_id}/events`,
    `/api/v1/pages/${page.page_id}/events`,
  ];
  return { rep, org, paths };
}

const readAll = async (paths: string[], headers: Record<string, string>) => Promise.all(paths.map(async (p) => ({ p, status: (await api(p, { headers })).status, body: await (await api(p, { headers })).text() })));
const secrets = ["9.9.9.9", "8.8.8.8", "7.7.7.7", "buyer@corp.example", "pagelead@corp.example"];

it("a current member reads every one of the six routes (control)", async () => {
  const s = await setup();
  const out = await readAll(s.paths, s.rep.headers);
  expect(out.map((o) => o.status)).toEqual([200, 200, 200, 200, 200, 200]);
});

it("after removal or demotion to viewer, no route returns a visitor email or IP", async () => {
  for (const end of [
    (s: Awaited<ReturnType<typeof setup>>) => env.DB.prepare("DELETE FROM organization_memberships WHERE organization_id = ? AND user_id = ?").bind(s.org, s.rep.userId).run(),
    (s: Awaited<ReturnType<typeof setup>>) => env.DB.prepare("UPDATE organization_memberships SET status = 'revoked' WHERE organization_id = ? AND user_id = ?").bind(s.org, s.rep.userId).run(),
    (s: Awaited<ReturnType<typeof setup>>) => env.DB.prepare("UPDATE organization_memberships SET role = 'viewer' WHERE organization_id = ? AND user_id = ?").bind(s.org, s.rep.userId).run(),
  ]) {
    const s = await setup();
    await end(s);
    for (const o of await readAll(s.paths, s.rep.headers)) {
      if (o.p.endsWith("/export/events")) {
        expect(o.status).toBe(200); // personal-scope export stays, minus rows on the org's domain
        for (const v of secrets) expect(o.body).not.toContain(v);
      } else {
        expect(o.status, o.p).toBe(403);
      }
      for (const v of secrets) expect(o.body).not.toContain(v);
    }
  }
});
