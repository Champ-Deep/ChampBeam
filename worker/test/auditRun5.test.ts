/**
 * Security audit run-5 regressions (Better Auth era). Each test fails without its fix:
 * open sign-up must not reach the shared org, a reset ends old sessions, the Better Auth organization
 * plugin honours ChampBeam's tombstone and deactivation rules, /leave ends reporting grants, and the
 * global assistant row is writable only from the operator org.
 */
import { describe, expect, it } from "vitest";
import { addMember, api, BASE, createOrg, createUser, env, json, orgSession, sessionHeaders } from "./helpers";
import { createAuth, joinsDefaultOrg } from "../src/auth/betterAuth";
import { getDb } from "../src/db/client";
import type { Env } from "../src/env";

const ORIGIN = { Origin: BASE };
let ipSeq = 0;
const ip = () => ({ "cf-connecting-ip": `198.51.103.${++ipSeq}` });
const POST = (path: string, headers: HeadersInit, body: unknown) => api(path, { method: "POST", headers, json: body });

async function operatorOrg(): Promise<string> {
  const row = await env.DB.prepare("SELECT id FROM organizations WHERE slug = 'champions-group'").first<{ id: string }>();
  if (row) return row.id;
  const org = await createOrg("org_operator_run5", "Champions Group");
  await env.DB.prepare("UPDATE organizations SET slug = 'champions-group' WHERE id = ?").bind(org.id).run();
  return org.id;
}
const membershipId = (orgId: string, userId: string) =>
  env.DB.prepare("SELECT id FROM organization_memberships WHERE organization_id = ? AND user_id = ?").bind(orgId, userId).first<{ id: string }>().then((r) => r!.id);
const roleOf = (id: string) => env.DB.prepare("SELECT role FROM organization_memberships WHERE id = ?").bind(id).first<{ role: string }>().then((r) => r?.role);

describe("open sign-up does not reach the shared org", () => {
  it("joinsDefaultOrg needs a verified address on an allowlisted domain", () => {
    const s = { autoJoinEmailDomains: ["championsmail.com"] };
    expect(joinsDefaultOrg(s, { email: "a@championsmail.com", emailVerified: true })).toBe(true);
    expect(joinsDefaultOrg(s, { email: "A@ChampionsMail.com", emailVerified: true })).toBe(true);
    expect(joinsDefaultOrg(s, { email: "a@championsmail.com", emailVerified: false })).toBe(false);
    expect(joinsDefaultOrg(s, { email: "a@championsmail.com.evil.test", emailVerified: true })).toBe(false);
    expect(joinsDefaultOrg(s, { email: "championsmail.com@evil.test", emailVerified: true })).toBe(false);
    expect(joinsDefaultOrg({ autoJoinEmailDomains: [] }, { email: "a@championsmail.com", emailVerified: true })).toBe(false);
  });

  it("a stranger who registers reads no roster, no rooms and no org data", async () => {
    const orgId = await operatorOrg();
    const admin = await createUser({ email: "admin-roster@example.com" });
    await addMember(orgId, admin.id, "admin");
    const email = `stranger-${crypto.randomUUID().slice(0, 8)}@example.com`;
    const up = await POST("/api/auth/sign-up/email", { ...ORIGIN, ...ip() }, { email, password: "long enough pw", name: "Stranger" });
    expect(up.status).toBe(200);
    const inn = await POST("/api/auth/sign-in/email", { ...ORIGIN, ...ip() }, { email, password: "long enough pw" });
    const cookie = { Cookie: inn.headers.getSetCookie().find((c) => c.includes("session_token="))!.split(";")[0]!, Origin: BASE };
    const members = await POST("/api/auth/organization/list-members", cookie, { organizationId: orgId });
    expect(members.status).not.toBe(200);
    expect(await members.text()).not.toContain("admin-roster@example.com");
    const full = await api(`/api/auth/organization/get-full-organization?organizationId=${orgId}`, { headers: cookie });
    expect(full.status).not.toBe(200);
    expect((await api("/api/v1/rooms", { headers: cookie })).status).toBe(403);
    expect((await api("/api/v1/org/members", { headers: cookie })).status).toBe(403);
  });
});

describe("password reset ends existing sessions", () => {
  it("a session opened before the reset is a 401 after it", async () => {
    const sent: { to: string; text: string }[] = [];
    const pending: Promise<unknown>[] = [];
    const auth = createAuth({ ...env, EMAIL: { send: async (m: { to: string; text: string }) => void sent.push(m) } } as unknown as Env, getDb(env.DB), (p) => void pending.push(p));
    const post = (path: string, body: unknown) =>
      auth.handler(new Request(`${BASE}/api/auth${path}`, { method: "POST", headers: { "content-type": "application/json", ...ORIGIN, ...ip() }, body: JSON.stringify(body) }));
    const email = `reset-${crypto.randomUUID().slice(0, 8)}@example.com`;
    expect((await post("/sign-up/email", { email, password: "first long password", name: "Resetter" })).status).toBe(200);
    const inn = await post("/sign-in/email", { email, password: "first long password" });
    const old = { Cookie: inn.headers.getSetCookie().find((c) => c.includes("session_token="))!.split(";")[0]!, Origin: BASE };
    expect((await api("/api/v1/auth/me", { headers: old })).status).toBe(200);

    expect((await post("/request-password-reset", { email, redirectTo: `${BASE}/reset-password` })).status).toBe(200);
    await Promise.all(pending);
    const token = /\/reset-password\/([^?\s]+)\?callbackURL=/.exec(sent.at(-1)!.text)?.[1];
    expect(token).toBeTruthy();
    expect((await post("/reset-password", { token, newPassword: "second long password" })).status).toBe(200);
    expect((await api("/api/v1/auth/me", { headers: old })).status).toBe(401);
  });
});

describe("Better Auth organization plugin honours ChampBeam membership rules", () => {
  async function tenant() {
    const org = await createOrg();
    const admin = await createUser();
    const target = await createUser();
    await addMember(org.id, admin.id, "admin");
    await addMember(org.id, target.id, "member");
    return { orgId: org.id, admin, target, targetMember: await membershipId(org.id, target.id) };
  }
  const promote = (h: HeadersInit, t: { orgId: string; targetMember: string }) =>
    POST("/api/auth/organization/update-member-role", h, { memberId: t.targetMember, role: "admin", organizationId: t.orgId });

  it("an active admin can still change a role (control)", async () => {
    const t = await tenant();
    expect((await promote(await sessionHeaders(t.admin.id, t.orgId), t)).status).toBe(200);
    expect(await roleOf(t.targetMember)).toBe("admin");
  });

  it("an admin whose membership is revoked changes nothing and reads nothing", async () => {
    const t = await tenant();
    await env.DB.prepare("UPDATE organization_memberships SET status = 'revoked' WHERE organization_id = ? AND user_id = ?").bind(t.orgId, t.admin.id).run();
    const h = await sessionHeaders(t.admin.id, t.orgId);
    expect((await promote(h, t)).status).toBe(403);
    expect(await roleOf(t.targetMember)).toBe("member");
    expect((await POST("/api/auth/organization/list-members", h, { organizationId: t.orgId })).status).toBe(403);
    // Naming the org by slug (no organizationId) must not dodge the check.
    const slug = (await env.DB.prepare("SELECT slug FROM organizations WHERE id = ?").bind(t.orgId).first<{ slug: string }>())!.slug;
    expect((await api(`/api/auth/organization/get-full-organization?organizationSlug=${slug}`, { headers: h })).status).toBe(403);
  });

  it("a deactivated admin is a 401 on the plugin routes", async () => {
    const t = await tenant();
    await env.DB.prepare("UPDATE users SET is_active = 0 WHERE id = ?").bind(t.admin.id).run();
    expect((await promote(await sessionHeaders(t.admin.id, t.orgId), t)).status).toBe(401);
    expect(await roleOf(t.targetMember)).toBe("member");
  });

  it("an admin cannot rename the organization (the default org is found by its slug)", async () => {
    const t = await tenant();
    const res = await POST("/api/auth/organization/update", await sessionHeaders(t.admin.id, t.orgId), { organizationId: t.orgId, data: { slug: `renamed-${crypto.randomUUID().slice(0, 6)}` } });
    expect(res.status).toBe(403);
  });

  it("leaving the org ends the leaver's reporting grants", async () => {
    const t = await tenant();
    await env.DB.prepare("INSERT INTO reporting_grants (id, organization_id, user_id, scope, created_at) VALUES (?,?,?,?,?)")
      .bind(crypto.randomUUID(), t.orgId, t.target.id, "org", new Date().toISOString()).run();
    const res = await POST("/api/auth/organization/leave", await sessionHeaders(t.target.id, t.orgId), { organizationId: t.orgId });
    expect(res.status).toBe(200);
    const g = await env.DB.prepare("SELECT revoked_at FROM reporting_grants WHERE user_id = ? AND organization_id = ?").bind(t.target.id, t.orgId).first<{ revoked_at: string | null }>();
    expect(g?.revoked_at).toBeTruthy();
  });
});

describe("the global assistant row is writable only from the operator org", () => {
  const put = (h: HeadersInit) => api("/api/v1/assistant/config", { method: "PUT", headers: h, json: { provider: "mock", model: "run5/model", enabled: true } });

  it("an admin of another tenant gets 403 and the row is unchanged; the operator org admin may write", async () => {
    const other = await orgSession({ role: "admin" });
    const before = await json(await api("/api/v1/assistant/config", { headers: other.headers }));
    expect((await put(other.headers)).status).toBe(403);
    expect((await json(await api("/api/v1/assistant/config", { headers: other.headers }))).model).toBe(before.model);

    const op = await operatorOrg();
    const admin = await createUser();
    await addMember(op, admin.id, "admin");
    const ok = await put(await sessionHeaders(admin.id, op));
    expect(ok.status).toBe(200);
    expect((await json(ok)).model).toBe("run5/model");
  });
});
