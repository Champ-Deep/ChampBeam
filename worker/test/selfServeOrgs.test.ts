/**
 * Self-serve orgs (card t_e1918443): personal signup, create org, super admin, invites, roles, email,
 * legacy share.lakeb2b.com serving, config. Real Worker via SELF.fetch against migrated in-memory D1.
 */
import { describe, expect, it, vi } from "vitest";
import { api, BASE, createOrg, createUser, addMember, env, json, sessionHeaders } from "./helpers";
import { createAuth } from "../src/auth/betterAuth";
import { getDb } from "../src/db/client";
import type { Env } from "../src/env";
import { iso, seedDomain, seedFile, seedLink, seedPage } from "./serveSeed";

const ORIGIN = { Origin: BASE };
let ipSeq = 0;
const ip = () => ({ "cf-connecting-ip": `198.51.101.${++ipSeq % 250}` });
const rid = () => crypto.randomUUID().slice(0, 8);

async function verified(email = `u-${rid()}@example.com`) {
  const u = await createUser({ email });
  await env.DB.prepare("UPDATE users SET email_verified = 1 WHERE id = ?").bind(u.id).run();
  return u;
}
async function superAdmin() {
  const existing = await env.DB.prepare("SELECT id FROM users WHERE email = 'root@example.com'").first<{ id: string }>();
  const id = existing?.id ?? (await createUser({ email: "root@example.com" })).id;
  await env.DB.prepare("UPDATE users SET email_verified = 1 WHERE id = ?").bind(id).run();
  return { id, headers: await sessionHeaders(id) };
}
const orgOfUser = (orgId: string, userId: string) =>
  env.DB.prepare("SELECT role FROM organization_memberships WHERE organization_id = ? AND user_id = ?").bind(orgId, userId).first<{ role: string }>();
const createOrgApi = (headers: Record<string, string>, slug: string, name = "Acme") =>
  api("/api/auth/organization/create", { method: "POST", headers, json: { name, slug } });

describe("create org", () => {
  it("a verified user creates an org, becomes its admin, and it is their active org", async () => {
    const u = await verified();
    const headers = await sessionHeaders(u.id);
    const slug = `acme-${rid()}`;
    const res = await createOrgApi(headers, slug);
    expect(res.status).toBe(200);
    const org = await json(res);
    expect((await orgOfUser(org.id, u.id))?.role).toBe("admin");
    const ctx = await json(await api("/api/v1/org/context", { headers }));
    expect(ctx).toMatchObject({ org_id: org.id, org_slug: slug, role: "admin", is_admin: true });
  });

  it("refuses an unverified password user", async () => {
    const u = await createUser();
    const res = await createOrgApi(await sessionHeaders(u.id), `nope-${rid()}`);
    expect(res.status).toBe(403);
  });

  it("allows an unverified user who signed in with Google", async () => {
    const u = await createUser();
    const now = Date.now();
    await env.DB.prepare("INSERT INTO account (id, account_id, provider_id, user_id, created_at, updated_at) VALUES (?,?,?,?,?,?)")
      .bind(crypto.randomUUID(), "g-" + u.id, "google", u.id, now, now)
      .run();
    expect((await createOrgApi(await sessionHeaders(u.id), `goog-${rid()}`)).status).toBe(200);
  });

  it("refuses reserved, uppercase and duplicate slugs", async () => {
    const u = await verified();
    const headers = await sessionHeaders(u.id);
    for (const slug of ["admin", "api", "www", "app", "champbeam"]) expect((await createOrgApi(headers, slug)).status).toBe(400);
    expect((await createOrgApi(headers, "Mixed-Case")).status).toBe(400);
    const slug = `dup-${rid()}`;
    expect((await createOrgApi(headers, slug)).status).toBe(200);
    expect((await createOrgApi(headers, slug)).status).toBe(400);
  });

  it("refuses renaming an org's slug to a reserved word", async () => {
    const u = await verified();
    const headers = await sessionHeaders(u.id);
    const org = await json(await createOrgApi(headers, `ren-${rid()}`));
    const res = await api("/api/auth/organization/update", { method: "POST", headers, json: { organizationId: org.id, data: { slug: "admin" } } });
    expect(res.status).toBe(400);
  });

  it("caps a user at 5 administered orgs; a super admin is exempt", async () => {
    const u = await verified();
    const headers = await sessionHeaders(u.id);
    for (let i = 0; i < 5; i++) expect((await createOrgApi(headers, `cap${i}-${rid()}`)).status).toBe(200);
    expect((await createOrgApi(headers, `cap6-${rid()}`)).status).toBe(403);

    const root = await superAdmin();
    for (let i = 0; i < 6; i++) expect((await createOrgApi(root.headers, `root${i}-${rid()}`)).status).toBe(200);
  });
});

describe("super admin", () => {
  it("is refused to everyone not in SUPER_ADMIN_EMAILS, and to the listed email while unverified", async () => {
    const plain = await verified();
    expect((await api("/api/v1/admin/orgs", { headers: await sessionHeaders(plain.id) })).status).toBe(403);
    await env.DB.prepare("DELETE FROM users WHERE email = 'root@example.com'").run();
    const squatter = await createUser({ email: "root@example.com" });
    expect((await api("/api/v1/admin/orgs", { headers: await sessionHeaders(squatter.id) })).status).toBe(403);
    expect((await api("/api/v1/config", { headers: await sessionHeaders(squatter.id) }).then(json)).is_super_admin).toBe(false);
  });

  it("an unverified listed email that is Google-linked counts", async () => {
    await env.DB.prepare("DELETE FROM users WHERE email = 'root@example.com'").run();
    const u = await createUser({ email: "root@example.com" });
    const now = Date.now();
    await env.DB.prepare("INSERT INTO account (id, account_id, provider_id, user_id, created_at, updated_at) VALUES (?,?,?,?,?,?)")
      .bind(crypto.randomUUID(), "g-" + u.id, "google", u.id, now, now)
      .run();
    expect((await api("/api/v1/admin/orgs", { headers: await sessionHeaders(u.id) })).status).toBe(200);
  });

  it("lists orgs with member and content counts; creates an org with a chosen first admin; adds a member; audits all", async () => {
    const root = await superAdmin();
    const first = await verified();
    const joiner = await verified();
    const slug = `sa-${rid()}`;
    const created = await api("/api/v1/admin/orgs", { method: "POST", headers: root.headers, json: { name: "Made By Root", slug, email: first.email } });
    expect(created.status).toBe(201);
    const { id } = await json(created);
    expect((await orgOfUser(id, first.id))?.role).toBe("admin");
    expect((await orgOfUser(id, root.id))).toBeNull();

    expect((await api("/api/v1/admin/orgs", { method: "POST", headers: root.headers, json: { name: "x", slug: "admin", user_id: first.id } })).status).toBe(400);
    expect((await api("/api/v1/admin/orgs", { method: "POST", headers: root.headers, json: { name: "x", slug, user_id: first.id } })).status).toBe(409);

    const add = await api(`/api/v1/admin/orgs/${id}/members`, { method: "POST", headers: root.headers, json: { user_id: joiner.id, role: "viewer" } });
    expect(add.status).toBe(201);
    expect((await orgOfUser(id, joiner.id))?.role).toBe("viewer");
    expect((await api(`/api/v1/admin/orgs/${id}/members`, { method: "POST", headers: root.headers, json: { user_id: joiner.id, role: "admin" } })).status).toBe(409);

    await seedFile(first.id, { organization_id: id });
    const list = await json(await api("/api/v1/admin/orgs", { headers: root.headers }));
    expect(list.orgs.find((o: any) => o.id === id)).toMatchObject({ slug, members: 2, files: 1, content_items: 0 });

    const audit = await env.DB.prepare("SELECT action FROM admin_audit WHERE actor_user_id = ? ORDER BY at").bind(root.id).all<{ action: string }>();
    expect(audit.results.map((r) => r.action)).toEqual(expect.arrayContaining(["org.create", "member.add"]));
  });

  async function twoOrgs() {
    const a = await createOrg(`org_${rid()}`, "SrcOrg");
    const b = await createOrg(`org_${rid()}`, "DstOrg");
    const admin = await createUser();
    const mover = await createUser();
    await addMember(a.id, admin.id, "admin");
    await addMember(a.id, mover.id, "leader");
    const file = await seedFile(mover.id, { organization_id: a.id });
    const linkId = await seedLink(mover.id, `m${rid()}`, { organization_id: a.id });
    const personal = await seedFile(mover.id); // no org: stays personal
    const contentId = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO content_items (id, organization_id, created_by_user_id, title, kind, is_archived, created_at, updated_at) VALUES (?,?,?,?,?,0,?,?)")
      .bind(contentId, a.id, mover.id, "Deck", "file", iso(), iso()).run();
    await env.DB.prepare("INSERT INTO content_shares (id, content_id, organization_id, shared_by_user_id, link_id, created_at) VALUES (?,?,?,?,?,?)")
      .bind(crypto.randomUUID(), contentId, a.id, mover.id, linkId, iso()).run();
    const sessionToken = await sessionHeaders(mover.id, a.id);
    return { a, b, admin, mover, file, linkId, personal, contentId, sessionToken };
  }
  const orgCol = (table: string, id: string) => env.DB.prepare(`SELECT organization_id AS o FROM ${table} WHERE id = ?`).bind(id).first<{ o: string | null }>().then((r) => r?.o);

  it("moves a member with their content, sessions and grants in one batch; personal content stays", async () => {
    const root = await superAdmin();
    const t = await twoOrgs();
    await env.DB.prepare("INSERT INTO reporting_grants (id, organization_id, user_id, scope, created_at) VALUES (?,?,?,'org',?)").bind(crypto.randomUUID(), t.a.id, t.mover.id, iso()).run();
    const res = await api("/api/v1/admin/members/move", { method: "POST", headers: root.headers, json: { user_id: t.mover.id, from_org_id: t.a.id, to_org_id: t.b.id } });
    expect(res.status).toBe(200);
    expect(await orgOfUser(t.a.id, t.mover.id)).toBeNull();
    expect((await orgOfUser(t.b.id, t.mover.id))?.role).toBe("leader");
    expect(await orgCol("file_assets", t.file.id)).toBe(t.b.id);
    expect(await orgCol("link_clicks", t.linkId)).toBe(t.b.id);
    expect(await orgCol("content_items", t.contentId)).toBe(t.b.id);
    expect(await orgCol("file_assets", t.personal.id)).toBeNull();
    const shareOrg = await env.DB.prepare("SELECT organization_id AS o FROM content_shares WHERE content_id = ?").bind(t.contentId).first<{ o: string }>();
    expect(shareOrg?.o).toBe(t.b.id);
    const sess = await env.DB.prepare("SELECT active_organization_id AS o FROM session WHERE user_id = ?").bind(t.mover.id).first<{ o: string }>();
    expect(sess?.o).toBe(t.b.id);
    const grant = await env.DB.prepare("SELECT revoked_at FROM reporting_grants WHERE user_id = ?").bind(t.mover.id).first<{ revoked_at: string | null }>();
    expect(grant?.revoked_at).toBeTruthy();
    const audit = await env.DB.prepare("SELECT payload FROM admin_audit WHERE action = 'member.move' AND target = ?").bind(t.mover.id).first<{ payload: string }>();
    expect(JSON.parse(audit!.payload)).toMatchObject({ from: t.a.id, to: t.b.id, move_content: true, leave_source: true });
  });

  it("move_content=false leaves content; leave_source=false keeps the source membership", async () => {
    const root = await superAdmin();
    const t = await twoOrgs();
    const res = await api("/api/v1/admin/members/move", {
      method: "POST", headers: root.headers,
      json: { user_id: t.mover.id, from_org_id: t.a.id, to_org_id: t.b.id, move_content: false, leave_source: false, role: "member" },
    });
    expect(res.status).toBe(200);
    expect((await orgOfUser(t.a.id, t.mover.id))?.role).toBe("leader");
    expect((await orgOfUser(t.b.id, t.mover.id))?.role).toBe("member");
    expect(await orgCol("file_assets", t.file.id)).toBe(t.a.id);
  });

  it("refuses to move the last admin out, a non-member, and the same org; changes nothing", async () => {
    const root = await superAdmin();
    const t = await twoOrgs();
    const move = (body: object) => api("/api/v1/admin/members/move", { method: "POST", headers: root.headers, json: body });
    expect((await move({ user_id: t.admin.id, from_org_id: t.a.id, to_org_id: t.b.id })).status).toBe(409);
    expect((await orgOfUser(t.a.id, t.admin.id))?.role).toBe("admin");
    expect((await move({ user_id: t.admin.id, from_org_id: t.b.id, to_org_id: t.a.id })).status).toBe(404);
    expect((await move({ user_id: t.mover.id, from_org_id: t.a.id, to_org_id: t.a.id })).status).toBe(400);
  });

  it("a conflicting content row rolls the whole move back", async () => {
    const root = await superAdmin();
    const t = await twoOrgs();
    await env.DB.prepare("UPDATE content_items SET champvault_asset_id = 'asset-1' WHERE id = ?").bind(t.contentId).run();
    await env.DB.prepare("INSERT INTO content_items (id, organization_id, title, kind, champvault_asset_id, is_archived, created_at, updated_at) VALUES (?,?,?,?,?,0,?,?)")
      .bind(crypto.randomUUID(), t.b.id, "Same asset", "file", "asset-1", iso(), iso()).run();
    const res = await api("/api/v1/admin/members/move", { method: "POST", headers: root.headers, json: { user_id: t.mover.id, from_org_id: t.a.id, to_org_id: t.b.id } });
    expect(res.status).toBe(409);
    expect((await orgOfUser(t.a.id, t.mover.id))?.role).toBe("leader");
    expect(await orgOfUser(t.b.id, t.mover.id)).toBeNull();
    expect(await orgCol("file_assets", t.file.id)).toBe(t.a.id);
  });

  it("a super admin who holds a lower role in the org still acts as admin there", async () => {
    const root = await superAdmin();
    const org = await createOrg(`org_${rid()}`, "Lower");
    await addMember(org.id, root.id, "viewer");
    const ctx = await json(await api("/api/v1/org/context", { headers: await sessionHeaders(root.id, org.id) }));
    expect(ctx).toMatchObject({ org_id: org.id, role: "admin", is_admin: true });
  });

  it("acts as admin in any org after act-as, and only a super admin can", async () => {
    const root = await superAdmin();
    const org = await createOrg(`org_${rid()}`, "Foreign");
    const before = await api("/api/v1/org/context", { headers: root.headers });
    expect(before.status).toBe(403);
    expect((await api("/api/v1/admin/act-as", { method: "POST", headers: root.headers, json: { organization_id: org.id } })).status).toBe(200);
    const ctx = await json(await api("/api/v1/org/context", { headers: root.headers }));
    expect(ctx).toMatchObject({ org_id: org.id, role: "admin", is_admin: true });

    const plain = await verified();
    expect((await api("/api/v1/admin/act-as", { method: "POST", headers: await sessionHeaders(plain.id), json: { organization_id: org.id } })).status).toBe(403);
    // A non-super user pointing a session at a foreign org gets nothing: the membership is re-read.
    expect((await api("/api/v1/org/context", { headers: await sessionHeaders(plain.id, org.id) })).status).toBe(403);
  });
});

describe("invitations", () => {
  async function orgWithAdmin() {
    const admin = await verified();
    const headers = await sessionHeaders(admin.id);
    const org = await json(await createOrgApi(headers, `inv-${rid()}`));
    return { admin, org, headers: await sessionHeaders(admin.id, org.id) };
  }
  const invite = (headers: Record<string, string>, email: string, role = "member") =>
    api("/api/v1/org/invitations", { method: "POST", headers, json: { email, role } });

  it("returns the accept URL on the platform host with a 7 day expiry; B signs up, accepts and is a member", async () => {
    const { org, headers } = await orgWithAdmin();
    const email = `b-${rid()}@example.com`;
    const res = await invite(headers, email, "leader");
    expect(res.status).toBe(201);
    const inv = await json(res);
    expect(inv.accept_url).toBe(`${BASE}/accept-invitation/${inv.id}`);
    expect(inv.email_sent).toBe(false);
    const days = (new Date(inv.expiresAt).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);

    // Sign-up with the invited email does nothing else: still no membership, invitation still pending.
    const up = await api("/api/auth/sign-up/email", { method: "POST", headers: { ...ORIGIN, ...ip() }, json: { email, password: "long enough pw", name: "Bee" } });
    expect(up.status).toBe(200);
    const b = (await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first<{ id: string }>())!;
    expect(await orgOfUser(org.id, b.id)).toBeNull();
    expect((await env.DB.prepare("SELECT status FROM invitation WHERE id = ?").bind(inv.id).first<{ status: string }>())?.status).toBe("pending");

    const bHeaders = await sessionHeaders(b.id);
    const acc = await api("/api/auth/organization/accept-invitation", { method: "POST", headers: bHeaders, json: { invitationId: inv.id } });
    expect(acc.status).toBe(200);
    expect((await orgOfUser(org.id, b.id))?.role).toBe("leader");
  });

  it("accept needs the session email to match the invited email", async () => {
    const { org, headers } = await orgWithAdmin();
    const email = `target-${rid()}@example.com`;
    const inv = await json(await invite(headers, email));
    const other = await verified();
    const res = await api("/api/auth/organization/accept-invitation", { method: "POST", headers: await sessionHeaders(other.id), json: { invitationId: inv.id } });
    expect(res.status).toBe(403);
    expect(await orgOfUser(org.id, other.id)).toBeNull();
  });

  it("an expired invitation cannot be accepted", async () => {
    const { headers } = await orgWithAdmin();
    const email = `late-${rid()}@example.com`;
    const inv = await json(await invite(headers, email));
    const u = await createUser({ email });
    await env.DB.prepare("UPDATE invitation SET expires_at = ? WHERE id = ?").bind(Date.now() - 1000, inv.id).run();
    expect((await api("/api/auth/organization/accept-invitation", { method: "POST", headers: await sessionHeaders(u.id), json: { invitationId: inv.id } })).status).toBe(400);
  });

  it("only admins invite; roles offered are admin, leader, member, viewer; an admin may invite an admin", async () => {
    const { org, headers } = await orgWithAdmin();
    for (const role of ["leader", "member", "viewer"]) {
      const u = await createUser();
      await addMember(org.id, u.id, role);
      expect((await invite(await sessionHeaders(u.id, org.id), `x-${rid()}@example.com`)).status).toBe(403);
    }
    expect((await invite(headers, `bad-${rid()}@example.com`, "owner")).status).toBe(422);
    expect((await invite(headers, `adm-${rid()}@example.com`, "admin")).status).toBe(201);
  });

  it("lists pending invitations with accept URLs for admins only", async () => {
    const { org, headers } = await orgWithAdmin();
    const inv = await json(await invite(headers, `l-${rid()}@example.com`));
    const list = await json(await api("/api/v1/org/invitations", { headers }));
    expect(list.map((i: any) => i.accept_url)).toContain(inv.accept_url);
    const m = await createUser();
    await addMember(org.id, m.id, "member");
    expect((await api("/api/v1/org/invitations", { headers: await sessionHeaders(m.id, org.id) })).status).toBe(403);
  });
});

describe("roles", () => {
  async function team() {
    const org = await createOrg(`org_${rid()}`, "Team");
    const admin = await createUser();
    const other = await createUser();
    const viewer = await createUser();
    await addMember(org.id, admin.id, "admin");
    await addMember(org.id, other.id, "member");
    await addMember(org.id, viewer.id, "viewer");
    const mid = async (userId: string) => (await env.DB.prepare("SELECT id FROM organization_memberships WHERE organization_id = ? AND user_id = ?").bind(org.id, userId).first<{ id: string }>())!.id;
    const headers = await sessionHeaders(admin.id, org.id);
    const setRole = (h: Record<string, string>, userId: string, role: string) =>
      mid(userId).then((memberId) => api("/api/auth/organization/update-member-role", { method: "POST", headers: h, json: { organizationId: org.id, memberId, role } }));
    const remove = async (h: Record<string, string>, userId: string) => {
      const u = (await env.DB.prepare("SELECT email FROM users WHERE id = ?").bind(userId).first<{ email: string }>())!;
      return api("/api/auth/organization/remove-member", { method: "POST", headers: h, json: { organizationId: org.id, memberIdOrEmail: u.email } });
    };
    return { org, admin, other, viewer, headers, setRole, remove };
  }

  it("admin promotes and demotes; a non-admin cannot", async () => {
    const t = await team();
    expect((await t.setRole(t.headers, t.other.id, "admin")).status).toBe(200);
    expect((await orgOfUser(t.org.id, t.other.id))?.role).toBe("admin");
    expect((await t.setRole(t.headers, t.other.id, "leader")).status).toBe(200);
    expect((await t.setRole(await sessionHeaders(t.viewer.id, t.org.id), t.other.id, "admin")).status).toBe(403);
  });

  it("refuses removing, demoting or self-demoting the last admin; allows it once a second admin exists", async () => {
    const t = await team();
    expect((await t.remove(t.headers, t.admin.id)).status).toBe(400);
    expect((await t.setRole(t.headers, t.admin.id, "member")).status).toBe(400);
    expect((await orgOfUser(t.org.id, t.admin.id))?.role).toBe("admin");
    const leave = await api("/api/auth/organization/leave", { method: "POST", headers: t.headers, json: { organizationId: t.org.id } });
    expect(leave.status).toBe(400);

    await t.setRole(t.headers, t.other.id, "admin");
    expect((await t.setRole(t.headers, t.admin.id, "member")).status).toBe(200);
    // the other admin is now the last one and is protected the same way
    const otherH = await sessionHeaders(t.other.id, t.org.id);
    expect((await t.setRole(otherH, t.other.id, "member")).status).toBe(400);
    expect((await t.remove(otherH, t.other.id)).status).toBe(400);
  });

  it("removing a member keeps their content in the org and ends their reporting grants", async () => {
    const t = await team();
    const file = await seedFile(t.other.id, { organization_id: t.org.id });
    await env.DB.prepare("INSERT INTO reporting_grants (id, organization_id, user_id, scope, created_at) VALUES (?,?,?,'org',?)").bind(crypto.randomUUID(), t.org.id, t.other.id, iso()).run();
    expect((await t.remove(t.headers, t.other.id)).status).toBe(200);
    expect(await orgOfUser(t.org.id, t.other.id)).toBeNull();
    expect((await env.DB.prepare("SELECT organization_id AS o FROM file_assets WHERE id = ?").bind(file.id).first<{ o: string }>())?.o).toBe(t.org.id);
    expect((await env.DB.prepare("SELECT revoked_at FROM reporting_grants WHERE user_id = ?").bind(t.other.id).first<{ revoked_at: string | null }>())?.revoked_at).toBeTruthy();
  });
});

describe("email behind the binding", () => {
  const withEmail = () => {
    const send = vi.fn(async () => ({ messageId: "m1" }));
    return { send, auth: createAuth({ ...env, EMAIL: { send } } as unknown as Env, getDb(env.DB)) };
  };

  it("sends verification mail on password sign-up from no-reply@champbeam.com, text plus HTML", async () => {
    const { send, auth } = withEmail();
    const email = `v-${rid()}@example.com`;
    await auth.api.signUpEmail({ body: { email, password: "long enough pw", name: "Vee" } });
    expect(send).toHaveBeenCalledTimes(1);
    const m = (send.mock.calls[0] as unknown as [{ to: string; from: string; text: string; html: string }])[0];
    expect(m.to).toBe(email);
    expect(m.from).toBe("ChampBeam <no-reply@champbeam.com>");
    expect(m.text).toMatch(/verify-email\?token=/);
    expect(m.html).toMatch(/<a href="[^"]*verify-email\?token=/);
  });

  it("sends password reset mail", async () => {
    const { send, auth } = withEmail();
    const email = `r-${rid()}@example.com`;
    await auth.api.signUpEmail({ body: { email, password: "long enough pw", name: "Rae" } });
    send.mockClear();
    await auth.api.requestPasswordReset({ body: { email, redirectTo: `${BASE}/reset` } });
    expect(send).toHaveBeenCalledTimes(1);
    expect((send.mock.calls[0] as unknown as [{ text: string }])[0].text).toMatch(/reset-password/);
  });

  it("emails the invitation with the platform-host accept URL, and then requires a verified email to accept", async () => {
    const { send, auth } = withEmail();
    const admin = await verified();
    const org = await createOrg(`org_${rid()}`, "Mailed");
    await addMember(org.id, admin.id, "admin");
    const h = await sessionHeaders(admin.id, org.id);
    const email = `inv-${rid()}@example.com`;
    const inv = await auth.api.createInvitation({ headers: new Headers(h), body: { email, role: "member", organizationId: org.id } });
    expect(send).toHaveBeenCalledTimes(1);
    const m = (send.mock.calls[0] as unknown as [{ to: string; text: string; html: string }])[0];
    expect(m.to).toBe(email);
    expect(m.text).toContain(`${BASE}/accept-invitation/${inv.id}`);
    expect(m.html).toContain(`${BASE}/accept-invitation/${inv.id}`);

    const u = await createUser({ email }); // unverified
    await expect(
      auth.api.acceptInvitation({ headers: new Headers(await sessionHeaders(u.id)), body: { invitationId: inv.id } }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await env.DB.prepare("UPDATE users SET email_verified = 1 WHERE id = ?").bind(u.id).run();
    await auth.api.acceptInvitation({ headers: new Headers(await sessionHeaders(u.id)), body: { invitationId: inv.id } });
    expect((await orgOfUser(org.id, u.id))?.role).toBe("member");
  });

  it("with no binding nothing is sent: reset is unavailable and config says email_enabled false", async () => {
    const auth = createAuth(env as unknown as Env, getDb(env.DB));
    const email = `n-${rid()}@example.com`;
    await auth.api.signUpEmail({ body: { email, password: "long enough pw", name: "Nia" } });
    await expect(auth.api.requestPasswordReset({ body: { email, redirectTo: `${BASE}/reset` } })).rejects.toBeTruthy();
    const cfg = await json(await api("/api/v1/config"));
    expect(cfg.email_enabled).toBe(false);
  });
});

describe("GET /api/v1/config", () => {
  it("reports email, custom domains, super admin and platform host", async () => {
    const anon = await json(await api("/api/v1/config"));
    expect(anon).toEqual({ email_enabled: false, custom_domains_enabled: false, is_super_admin: false, platform_host: "share.example.com" });
    const root = await superAdmin();
    expect((await json(await api("/api/v1/config", { headers: root.headers }))).is_super_admin).toBe(true);
    const plain = await verified();
    expect((await json(await api("/api/v1/config", { headers: await sessionHeaders(plain.id) }))).is_super_admin).toBe(false);
  });
});

describe("share.lakeb2b.com legacy serving", () => {
  async function setup() {
    const cg = await createOrg(`org_${rid()}`, "ChampionsGroup");
    const lake = await createOrg(`org_${rid()}`, "LakeB2B");
    const cgUser = await createUser();
    const lakeUser = await createUser();
    await addMember(cg.id, cgUser.id, "member");
    await addMember(lake.id, lakeUser.id, "admin");
    const host = `share-${rid()}.lakeb2b.test`;
    const domainId = await seedDomain(lakeUser.id, host);
    await env.DB.prepare("UPDATE domains SET organization_id = ? WHERE id = ?").bind(lake.id, domainId).run();
    const cutoff = iso(-60_000);
    const oldCg = await seedPage(cgUser.id, "<p>old</p>", { organization_id: cg.id, created_at: iso(-3_600_000), slug: `old-${rid()}` });
    const newCg = await seedPage(cgUser.id, "<p>new</p>", { organization_id: cg.id, created_at: iso(), slug: `new-${rid()}` });
    const lakeAsset = await seedFile(lakeUser.id, { organization_id: lake.id, domain_id: domainId, body: "lake" });
    const oldLink = await seedLink(cgUser.id, `o${rid()}`, { organization_id: cg.id, created_at: iso(-3_600_000) });
    const newLink = await seedLink(cgUser.id, `n${rid()}`, { organization_id: cg.id });
    const code = async (id: string) => (await env.DB.prepare("SELECT short_code AS c FROM link_clicks WHERE id = ?").bind(id).first<{ c: string }>())!.c;
    const root = await superAdmin();
    const setLegacy = (v: string | null) => api(`/api/v1/admin/domains/${domainId}/legacy`, { method: "PUT", headers: root.headers, json: { legacy_platform_before: v } });
    return { host, domainId, cutoff, oldCg, newCg, lakeAsset, oldLink: await code(oldLink), newLink: await code(newLink), setLegacy };
  }
  const get = (host: string, path: string) => api(`https://${host}${path}`);

  it("an old Champions link resolves on the host, a new Champions platform link 404s, a LakeB2B domain link resolves", async () => {
    const t = await setup();
    expect((await t.setLegacy(t.cutoff)).status).toBe(200);
    expect((await get(t.host, `/f/${t.oldCg.shortCode}`)).status).toBe(200);
    expect((await get(t.host, `/f/${t.newCg.shortCode}`)).status).toBe(404);
    expect((await get(t.host, `/f/${t.lakeAsset.shortCode}`)).status).toBe(200);
    // slug path (pages, root-slug hosting and /p/): old resolves, new does not
    expect((await get(t.host, `/${t.oldCg.slug}`)).status).toBe(200);
    expect((await get(t.host, `/p/${t.oldCg.slug}`)).status).toBe(200);
    expect((await get(t.host, `/${t.newCg.slug}`)).status).toBe(404);
    expect((await get(t.host, `/p/${t.newCg.slug}`)).status).toBe(404);
    // a retired slug (alias) of an old page still resolves through the alias lookup
    await env.DB.prepare("INSERT INTO slug_aliases (id, slug, domain_id, file_id, created_at) VALUES (?,?,NULL,?,?)").bind(crypto.randomUUID(), `retired-${t.oldCg.slug}`, t.oldCg.id, iso()).run();
    expect((await get(t.host, `/p/retired-${t.oldCg.slug}`)).status).toBe(200);
    // redirect links follow the same rule
    expect((await get(t.host, `/s/${t.oldLink}`)).headers.get("location")).toBe("https://example.com/dest");
    expect((await get(t.host, `/s/${t.newLink}`)).headers.get("location")).toBe("/");
    // the platform host is unchanged
    expect((await get("share.example.com", `/f/${t.newCg.shortCode}`)).status).toBe(200);
  });

  it("without the flag the host serves only its own content", async () => {
    const t = await setup();
    expect((await get(t.host, `/f/${t.oldCg.shortCode}`)).status).toBe(404);
    expect((await get(t.host, `/f/${t.lakeAsset.shortCode}`)).status).toBe(200);
    await t.setLegacy(t.cutoff);
    expect((await get(t.host, `/f/${t.oldCg.shortCode}`)).status).toBe(200);
    await t.setLegacy(null);
    expect((await get(t.host, `/f/${t.oldCg.shortCode}`)).status).toBe(404);
  });

  it("the flag is super admin only, validated, and audited", async () => {
    const t = await setup();
    const plain = await verified();
    const res = await api(`/api/v1/admin/domains/${t.domainId}/legacy`, { method: "PUT", headers: await sessionHeaders(plain.id), json: { legacy_platform_before: t.cutoff } });
    expect(res.status).toBe(403);
    expect((await t.setLegacy("not a date")).status).toBe(400);
    const ok = await json(await t.setLegacy("2026-11-06T13:21:38Z"));
    expect(ok.legacy_platform_before).toBe("2026-11-06T13:21:38.000Z");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'domain.legacy' AND target = ?").bind(t.domainId).first<{ n: number }>())?.n).toBe(1);
  });
});
