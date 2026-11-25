/**
 * Backend gaps found while building the self-serve orgs UI (card t_ea2281ef): last active per member and the
 * super admin's view of an org's members. Item 1 (TXT records) is domainRecords.test.ts; item 4 (Google return
 * path) is betterAuth.test.ts "Google sign-in".
 */
import { describe, expect, it } from "vitest";
import { addMember, api, createOrg, createUser, env, json, sessionHeaders } from "./helpers";

const rid = () => crypto.randomUUID().slice(0, 8);
const T_SESSION = Date.parse("2026-03-01T10:00:00.000Z");
const T_SHARE_OLD = "2026-02-01T10:00:00.000Z";
const T_SHARE_NEW = "2026-04-01T10:00:00.000Z";

async function superAdmin() {
  const existing = await env.DB.prepare("SELECT id FROM users WHERE email = 'root@example.com'").first<{ id: string }>();
  const id = existing?.id ?? (await createUser({ email: "root@example.com" })).id;
  await env.DB.prepare("UPDATE users SET email_verified = 1 WHERE id = ?").bind(id).run();
  return { id, headers: await sessionHeaders(id) };
}

async function share(orgId: string, userId: string, at: string) {
  const contentId = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO content_items (id, organization_id, created_by_user_id, title, kind, is_archived, created_at, updated_at) VALUES (?,?,?,?,?,0,?,?)")
    .bind(contentId, orgId, userId, "Deck", "file", at, at).run();
  await env.DB.prepare("INSERT INTO content_shares (id, content_id, organization_id, shared_by_user_id, created_at) VALUES (?,?,?,?,?)")
    .bind(crypto.randomUUID(), contentId, orgId, userId, at).run();
}

/** An org with: admin (signed in now), sessioned (session at T_SESSION plus an older share), sharer (share only), idle. */
async function seededOrg() {
  const org = await createOrg(`org_${rid()}`, "Gaps");
  const [admin, sessioned, sharer, idle] = await Promise.all([1, 2, 3, 4].map(() => createUser()));
  for (const [u, role] of [[admin, "admin"], [sessioned, "member"], [sharer, "leader"], [idle, "viewer"]] as const) await addMember(org.id, u.id, role);
  await sessionHeaders(sessioned.id, org.id);
  await env.DB.prepare("UPDATE session SET updated_at = ? WHERE user_id = ?").bind(T_SESSION, sessioned.id).run();
  await share(org.id, sessioned.id, T_SHARE_OLD);
  await share(org.id, sharer.id, T_SHARE_NEW);
  return { org, admin, sessioned, sharer, idle };
}

describe("last active per member", () => {
  it("GET /org/members gives the later of the last session touch and the last share, null when neither", async () => {
    const { org, admin, sessioned, sharer, idle } = await seededOrg();
    const before = Date.now();
    const res = await api("/api/v1/org/members", { headers: await sessionHeaders(admin.id, org.id) });
    expect(res.status).toBe(200);
    const by = new Map((await json(res)).map((m: { user_id: string; last_active_at: string | null }) => [m.user_id, m.last_active_at]));
    expect(by.get(sessioned.id)).toBe(new Date(T_SESSION).toISOString());
    expect(by.get(sharer.id)).toBe(T_SHARE_NEW);
    expect(by.get(idle.id)).toBeNull();
    expect(Date.parse(by.get(admin.id) as string)).toBeGreaterThanOrEqual(before - 1000); // this request's session
  });
});

describe("super admin: an org's members", () => {
  it("lists active members with role, joined and last active, without being a member", async () => {
    const root = await superAdmin();
    const { org, admin, sessioned, sharer, idle } = await seededOrg();
    const gone = await createUser();
    await env.DB.prepare(
      "INSERT INTO organization_memberships (id, organization_id, user_id, role, status, revoked_at, created_at, updated_at) VALUES (?,?,?,?,'revoked',?,?,?)",
    ).bind(crypto.randomUUID(), org.id, gone.id, "member", T_SHARE_NEW, T_SHARE_NEW, T_SHARE_NEW).run();
    expect(await env.DB.prepare("SELECT 1 FROM organization_memberships WHERE organization_id = ? AND user_id = ?").bind(org.id, root.id).first()).toBeNull();

    const res = await api(`/api/v1/admin/orgs/${org.id}/members`, { headers: root.headers });
    expect(res.status).toBe(200);
    const { members } = await json(res);
    expect(members.map((m: { user_id: string }) => m.user_id).sort()).toEqual([admin.id, sessioned.id, sharer.id, idle.id].sort());
    const s = members.find((m: { user_id: string }) => m.user_id === sessioned.id);
    expect(s).toMatchObject({ email: sessioned.email, role: "member", last_active_at: new Date(T_SESSION).toISOString() });
    expect(s.member_id).toBeTruthy();
    expect(Date.parse(s.joined_at)).not.toBeNaN();
    expect(members.find((m: { user_id: string }) => m.user_id === idle.id)).toMatchObject({ role: "viewer", last_active_at: null });
  });

  it("is 403 for the org's own admin and 404 for an unknown org", async () => {
    const root = await superAdmin();
    const { org, admin } = await seededOrg();
    expect((await api(`/api/v1/admin/orgs/${org.id}/members`, { headers: await sessionHeaders(admin.id, org.id) })).status).toBe(403);
    expect((await api(`/api/v1/admin/orgs/${crypto.randomUUID()}/members`, { headers: root.headers })).status).toBe(404);
  });
});
