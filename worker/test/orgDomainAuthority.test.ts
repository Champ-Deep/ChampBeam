/**
 * An org-attached domain is the org's: a revoked or demoted former admin can no longer delete it
 * (or set-primary / refresh it) through the personal /api/v1/domains routes. An active admin still can.
 */
import { expect, it } from "vitest";
import { api, env, json } from "./helpers";
import { member, newOrgId, setSettings, useRouteTestHooks } from "./orgTestUtils";

useRouteTestHooks();

const q = (sql: string, ...b: unknown[]) => env.DB.prepare(sql).bind(...b).first<Record<string, any>>();

async function orgDomain() {
  setSettings({ platformSubdomainBase: "authority.test" });
  const clerkOrg = newOrgId();
  const admin = await member(clerkOrg, "admin");
  const org = (await q("SELECT id FROM organizations WHERE clerk_org_id = ?", clerkOrg))!.id as string;
  const d = await json(await api("/api/v1/domains", { method: "POST", json: { hostname: `d-${crypto.randomUUID().slice(0, 6)}.authority.test` }, headers: admin.headers }));
  expect((await api(`/api/v1/org/domains/${d.id}/attach`, { method: "POST", headers: admin.headers })).status).toBe(200);
  return { admin, org, id: d.id as string };
}

it("revoked former admin cannot delete, set-primary or refresh the org's domain", async () => {
  const s = await orgDomain();
  await env.DB.prepare("UPDATE organization_memberships SET status='revoked' WHERE organization_id = ? AND user_id = ?").bind(s.org, s.admin.userId).run();
  for (const [method, path] of [["DELETE", ""], ["POST", "/set-primary"], ["POST", "/refresh"]] as const) {
    expect((await api(`/api/v1/domains/${s.id}${path}`, { method, headers: s.admin.headers })).status, `${method} ${path}`).toBe(403);
  }
  expect((await q("SELECT COUNT(*) AS n FROM domains WHERE id = ?", s.id))!.n).toBe(1);
});

it("another active admin of the org manages it after the attaching admin leaves; other orgs cannot see it", async () => {
  const s = await orgDomain();
  const clerkOrg = (await q("SELECT clerk_org_id FROM organizations WHERE id = ?", s.org))!.clerk_org_id as string;
  const admin2 = await member(clerkOrg, "admin");
  const rep = await member(clerkOrg, "member");
  const outsider = await member(newOrgId(), "admin");
  await env.DB.prepare("UPDATE users SET is_active = 0 WHERE id = ?").bind(s.admin.userId).run(); // user.deleted
  expect((await api(`/api/v1/domains/${s.id}/refresh`, { method: "POST", headers: rep.headers })).status).toBe(404);
  expect((await api(`/api/v1/domains/${s.id}`, { method: "DELETE", headers: outsider.headers })).status).toBe(404);
  expect((await api(`/api/v1/domains/${s.id}/set-primary`, { method: "POST", headers: admin2.headers })).status).toBe(404);
  expect((await api(`/api/v1/domains/${s.id}`, { method: "DELETE", headers: admin2.headers })).status).toBe(204);
  expect((await q("SELECT COUNT(*) AS n FROM domains WHERE id = ?", s.id))!.n).toBe(0);
});

it("admin demoted to member by Clerk cannot delete it; an active admin can", async () => {
  const s = await orgDomain();
  await env.DB.prepare("UPDATE organization_memberships SET clerk_membership_id='mem_t', role='member' WHERE organization_id = ? AND user_id = ?").bind(s.org, s.admin.userId).run();
  expect((await api(`/api/v1/domains/${s.id}`, { method: "DELETE", headers: s.admin.headers })).status).toBe(403);
  await env.DB.prepare("UPDATE organization_memberships SET role='admin' WHERE organization_id = ? AND user_id = ?").bind(s.org, s.admin.userId).run();
  expect((await api(`/api/v1/domains/${s.id}`, { method: "DELETE", headers: s.admin.headers })).status).toBe(204);
  expect((await q("SELECT COUNT(*) AS n FROM domains WHERE id = ?", s.id))!.n).toBe(0);
});
