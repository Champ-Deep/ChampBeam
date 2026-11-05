/**
 * Audit run-4 regressions (dummy tenants only):
 *  - a deleted platform page keeps its slug against other tenants; its owner can still re-add it
 *  - a removed org member cannot revive a link's access or finalize a staged upload on the org's domain
 */
import { expect, it } from "vitest";
import { api, env, json } from "./helpers";
import { member, newOrgId, setSettings, useRouteTestHooks } from "./orgTestUtils";
import { seedPage } from "./serveSeed";

useRouteTestHooks();

const q = (sql: string, ...b: unknown[]) => env.DB.prepare(sql).bind(...b).first<Record<string, any>>();
const html = (m: string) => `<!doctype html><html><head><title>T</title></head><body>${m}</body></html>`;
const pub = (h: Record<string, string>, slug: string, m: string) =>
  api("/api/v1/pages", { method: "POST", json: { html: html(m), title: "P", slug }, headers: h });

it("a deleted page's platform slug is not reissued to another tenant; the former owner can re-add it", async () => {
  const victim = await member(newOrgId(), "member");
  const attacker = await member(newOrgId(), "member");
  const slug = `r4d-${crypto.randomUUID().slice(0, 6)}`;
  const v = await json(await pub(victim.headers, slug, "VICTIM"));
  expect((await api(`/api/v1/pages/${v.page_id}`, { method: "DELETE", headers: victim.headers })).status).toBe(204);
  expect((await pub(attacker.headers, slug, "ATTACKER")).status).toBe(409);
  const sug = await json(await api(`/api/v1/pages/slug-suggestion?filename=${slug}.html`, { headers: attacker.headers }));
  expect(sug.slug).not.toBe(slug);
  expect((await pub(victim.headers, slug, "VICTIM-AGAIN")).status).toBe(201);
});

async function orgSetup() {
  setSettings({ platformSubdomainBase: "r4.test" });
  const clerkOrg = newOrgId();
  const admin = await member(clerkOrg, "admin");
  const rep = await member(clerkOrg, "member");
  const org = (await q("SELECT id FROM organizations WHERE clerk_org_id = ?", clerkOrg))!.id as string;
  const d = await json(await api("/api/v1/domains", { method: "POST", json: { hostname: `o-${crypto.randomUUID().slice(0, 6)}.r4.test` }, headers: admin.headers }));
  expect((await api(`/api/v1/org/domains/${d.id}/attach`, { method: "POST", headers: admin.headers })).status).toBe(200);
  const revoke = () =>
    env.DB.prepare("UPDATE organization_memberships SET status='revoked' WHERE organization_id = ? AND user_id = ?").bind(org, rep.userId).run();
  return { rep, d, revoke };
}

it("a removed member cannot re-enable their link on the org's domain", async () => {
  const s = await orgSetup();
  const g = await json(await api("/api/v1/utm/generate", { method: "POST", json: { base_url: "https://dest.example/x", domain_id: s.d.id }, headers: s.rep.headers }));
  expect((await q("SELECT domain_id FROM link_clicks WHERE id = ?", g.link_id))!.domain_id).toBe(s.d.id);
  expect((await api(`/api/v1/utm/links/${g.link_id}/access`, { method: "PUT", json: { revoked: true }, headers: s.rep.headers })).status).toBe(200);
  await s.revoke();
  expect((await api(`/api/v1/utm/links/${g.link_id}/access`, { method: "PUT", json: { revoked: false }, headers: s.rep.headers })).status).toBe(403);
  expect((await q("SELECT revoked_at FROM link_clicks WHERE id = ?", g.link_id))!.revoked_at).not.toBeNull();
});

it("a removed member cannot finalize a staged upload onto the org's domain", async () => {
  const s = await orgSetup();
  const body = new TextEncoder().encode("%PDF-1.4 staged bytes");
  const init = await json(await api("/api/v1/files", { method: "POST", json: { filename: "staged.pdf", content_type: "application/pdf", size_bytes: body.length, domain_id: s.d.id, intent: "host" }, headers: s.rep.headers }));
  expect((await api(init.presigned_put_url, { method: "PUT", body, headers: { "Content-Type": "application/pdf" } })).status).toBeLessThan(300);
  await s.revoke();
  expect((await api(`/api/v1/files/${init.file_id}/finalize`, { method: "POST", headers: s.rep.headers })).status).toBe(403);
  expect((await q("SELECT status FROM file_assets WHERE id = ?", init.file_id))!.status).not.toBe("active");
});

it("a comma content_type is never served with a browser-resolvable text/html", async () => {
  const u = await member(newOrgId(), "member");
  const body = new TextEncoder().encode("<script>parent.x=1</script>");
  const init = await json(await api("/api/v1/files", { method: "POST", json: { filename: "a.png", content_type: "image/png;,text/html", size_bytes: body.length }, headers: u.headers }));
  expect((await api(init.presigned_put_url, { method: "PUT", body, headers: { "Content-Type": "image/png;,text/html" } })).status).toBeLessThan(300);
  expect((await api(`/api/v1/files/${init.file_id}/finalize`, { method: "POST", headers: u.headers })).status).toBe(200);
  const r = await api(`/f/${init.short_code}`);
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toBe("image/png");
});

it("a content-library share of a legacy (unsandboxed) HTML file is a sandboxed new asset", async () => {
  const org = newOrgId();
  const admin = await member(org, "admin");
  const rep = await member(org, "member");
  const legacy = await seedPage(admin.userId, "<!doctype html><html><body>hi</body></html>"); // html_sandbox NULL, as before 0003
  const content = await json(await api("/api/v1/content", { method: "POST", json: { title: "Legacy", kind: "file", file_id: legacy.id }, headers: admin.headers }));
  expect((await api(`/api/v1/content/${content.id}/share`, { method: "POST", json: {}, headers: rep.headers })).status).toBeLessThan(300);
  const copy = await q("SELECT html_sandbox FROM file_assets WHERE user_id = ? AND kind = 'html'", rep.userId);
  expect(copy!.html_sandbox).toBe(1);
});

it("a keep-slug domain move retires the old platform slug, so another tenant cannot take the published URL", async () => {
  setSettings({ platformSubdomainBase: "mv4.test" });
  const victim = await member(newOrgId(), "member");
  const attacker = await member(newOrgId(), "member");
  const slug = `mv4-${crypto.randomUUID().slice(0, 6)}`;
  const v = await json(await pub(victim.headers, slug, "VICTIM"));
  const d = await json(await api("/api/v1/domains", { method: "POST", json: { hostname: `v-${crypto.randomUUID().slice(0, 6)}.mv4.test` }, headers: victim.headers }));
  expect((await api(`/api/v1/pages/${v.page_id}`, { method: "PATCH", json: { domain_id: d.id }, headers: victim.headers })).status).toBe(200);
  expect((await pub(attacker.headers, slug, "ATTACKER")).status).toBe(409);
});
