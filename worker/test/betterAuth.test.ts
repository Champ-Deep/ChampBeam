/**
 * Better Auth on D1 (card t_fca02bea, docs/BETTER-AUTH-PRD.md section 4).
 * Every request goes through the real Worker (SELF.fetch) against migrated in-memory D1.
 */
import { describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { api, BASE, createApiKey, createUser, env, json, sessionHeaders } from "./helpers";
import { buildSettings, getSettings, type Env } from "../src/env";
import { createAuth } from "../src/auth/betterAuth";
import { getDb } from "../src/db/client";

const COOKIE = "__Secure-champbeam.session_token";
const ORIGIN = { Origin: BASE };
let ipSeq = 0;
/** A fresh client IP per test, so the sign-in rate limit (5 per 60 s per IP) never couples tests. */
const ip = () => ({ "cf-connecting-ip": `198.51.100.${++ipSeq}` });

const sessionCookie = (res: Response) =>
  res.headers.getSetCookie().find((c) => c.startsWith(`${COOKIE}=`)) ?? null;
const cookieHeader = (setCookie: string) => ({ Cookie: setCookie.split(";")[0] });

async function signIn(email: string, password: string, extra: Record<string, string> = {}) {
  return api("/api/auth/sign-in/email", { method: "POST", headers: { ...ORIGIN, ...ip(), ...extra }, json: { email, password } });
}

async function defaultOrg() {
  const row = await env.DB.prepare("SELECT id FROM organizations WHERE slug = 'champions-group'").first<{ id: string }>();
  if (row) return row.id;
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO organizations (id, clerk_org_id, name, slug, created_at, updated_at) VALUES (?,?,?,?,?,?)")
    .bind(id, crypto.randomUUID(), "Champions Group", "champions-group", new Date().toISOString(), new Date().toISOString())
    .run();
  return id;
}

async function addMembership(orgId: string, userId: string, role: string) {
  await env.DB.prepare(
    "INSERT INTO organization_memberships (id, organization_id, user_id, role, created_at, updated_at) VALUES (?,?,?,?,?,?)",
  )
    .bind(crypto.randomUUID(), orgId, userId, role, new Date().toISOString(), new Date().toISOString())
    .run();
}

describe("email and password", () => {
  it("sign-up then sign-in sets an HttpOnly, Secure, SameSite=Lax session cookie that /api/v1 resolves", async () => {
    const email = `ba-${crypto.randomUUID().slice(0, 8)}@example.com`;
    const up = await api("/api/auth/sign-up/email", {
      method: "POST",
      headers: { ...ORIGIN, ...ip() },
      json: { email, password: "correct horse battery", name: "Bea Auth" },
    });
    expect(up.status).toBe(200);

    const res = await signIn(email, "correct horse battery");
    expect(res.status).toBe(200);
    const set = sessionCookie(res);
    expect(set).not.toBeNull();
    expect(set).toMatch(/;\s*HttpOnly/i);
    expect(set).toMatch(/;\s*Secure/i);
    expect(set).toMatch(/;\s*SameSite=Lax/i);

    const row = await env.DB.prepare("SELECT id, full_name FROM users WHERE email = ?").bind(email).first<{ id: string; full_name: string }>();
    expect(row?.full_name).toBe("Bea Auth");
    const me = await api("/api/v1/auth/me", { headers: cookieHeader(set!) });
    expect(me.status).toBe(200);
    expect((await json(me)).user_id).toBe(row!.id);
  });

  it("an imported Clerk bcrypt hash verifies with the right password and is a 401 with the wrong one", async () => {
    const user = await createUser({ email: `bc-${crypto.randomUUID().slice(0, 8)}@example.com` });
    const hash = bcrypt.hashSync("hunter2-hunter2", 10);
    expect(hash.startsWith("$2")).toBe(true);
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO account (id, account_id, provider_id, user_id, password, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
    )
      .bind(crypto.randomUUID(), user.id, "credential", user.id, hash, now, now)
      .run();

    const ok = await signIn(user.email, "hunter2-hunter2");
    expect(ok.status).toBe(200);
    expect(sessionCookie(ok)).not.toBeNull();
    const bad = await signIn(user.email, "wrong-password");
    expect(bad.status).toBe(401);
  });

  it("sign-in is rate limited to 5 attempts per 60 s per IP", async () => {
    const fixed = { "cf-connecting-ip": "203.0.113.77" };
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await signIn("nobody@example.com", "x-wrong-pass", fixed)).status);
    expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
    expect(statuses[5]).toBe(429);
  });

  it("a new sign-up is personal: it joins no org, even when champions-group exists", async () => {
    await defaultOrg();
    const email = `join-${crypto.randomUUID().slice(0, 8)}@example.com`;
    const up = await api("/api/auth/sign-up/email", {
      method: "POST",
      headers: { ...ORIGIN, ...ip() },
      json: { email, password: "long enough pw", name: "Joiner" },
    });
    expect(up.status).toBe(200);
    const n = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM organization_memberships m JOIN users u ON u.id = m.user_id WHERE u.email = ?",
    )
      .bind(email)
      .first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it("a member's new session lands in their org; a user with no membership lands in Personal", async () => {
    const orgId = await defaultOrg();
    const email = `land-${crypto.randomUUID().slice(0, 8)}@example.com`;
    await api("/api/auth/sign-up/email", { method: "POST", headers: { ...ORIGIN, ...ip() }, json: { email, password: "long enough pw", name: "Lander" } });
    const uid = (await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first<{ id: string }>())!.id;
    await addMembership(orgId, uid, "member");
    const res = await signIn(email, "long enough pw");
    const s = await api("/api/auth/get-session", { headers: cookieHeader(sessionCookie(res)!) });
    expect(((await s.json()) as { session: { activeOrganizationId: string | null } }).session.activeOrganizationId).toBe(orgId);

    await env.DB.prepare("DELETE FROM organization_memberships WHERE user_id = ?").bind(uid).run();
    const res2 = await signIn(email, "long enough pw");
    const s2 = await api("/api/auth/get-session", { headers: cookieHeader(sessionCookie(res2)!) });
    expect(((await s2.json()) as { session: { activeOrganizationId: string | null } }).session.activeOrganizationId ?? null).toBeNull();
  });

  it("a deactivated user's session is a 401", async () => {
    const user = await createUser();
    await env.DB.prepare("UPDATE users SET is_active = 0 WHERE id = ?").bind(user.id).run();
    const me = await api("/api/v1/auth/me", { headers: await sessionHeaders(user.id) });
    expect(me.status).toBe(401);
  });
});

describe("organizations", () => {
  it("admin sets the active org; report.org is admin only; a removed member loses the org on the next request", async () => {
    const orgId = await defaultOrg();
    const admin = await createUser();
    const member = await createUser();
    await addMembership(orgId, admin.id, "admin");
    await addMembership(orgId, member.id, "member");
    const adminH = await sessionHeaders(admin.id);
    const memberH = await sessionHeaders(member.id);

    // No active org yet: team features ask for one.
    const before = await api("/api/v1/org/viewers", { headers: adminH });
    expect(before.status).toBe(403);
    expect((await json(before)).detail).toMatch(/Select an organization/);

    for (const h of [adminH, memberH]) {
      const set = await api("/api/auth/organization/set-active", { method: "POST", headers: h, json: { organizationId: orgId } });
      expect(set.status).toBe(200);
    }

    // report.org drives the reporting scope; org.viewers.grant goes through requirePermission.
    const adminProfile = await json(await api("/api/v1/org/profile", { headers: adminH }));
    expect(adminProfile.report_scope).toBe("org");
    expect(adminProfile.org.id).toBe(orgId);
    expect((await api("/api/v1/org/viewers", { headers: adminH })).status).toBe(200);
    const memberProfile = await json(await api("/api/v1/org/profile", { headers: memberH }));
    expect(memberProfile.report_scope).not.toBe("org");
    expect((await api("/api/v1/org/viewers", { headers: memberH })).status).toBe(403);
    const ctx = await json(await api("/api/v1/org/context", { headers: memberH }));
    expect(ctx.org_id).toBe(orgId);

    const removed = await api("/api/auth/organization/remove-member", {
      method: "POST",
      headers: adminH,
      json: { memberIdOrEmail: member.email, organizationId: orgId },
    });
    expect(removed.status).toBe(200);
    const after = await api("/api/v1/org/context", { headers: memberH });
    expect(after.status).toBe(403);
    expect((await json(after)).detail).toMatch(/Select an organization/);
  });

  it("an unverified, non-Google user cannot create an organization", async () => {
    const user = await createUser();
    const res = await api("/api/auth/organization/create", {
      method: "POST",
      headers: await sessionHeaders(user.id),
      json: { name: "Rogue", slug: `rogue-${crypto.randomUUID().slice(0, 6)}` },
    });
    expect(res.status).toBe(403);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM organizations WHERE name = 'Rogue'").first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it("an org inserted through the Better Auth adapter gets a non-null clerk_org_id", async () => {
    const auth = createAuth(env as unknown as Env, getDb(env.DB));
    const ctx = await auth.$context;
    const slug = `adapter-${crypto.randomUUID().slice(0, 6)}`;
    const org = await ctx.adapter.create<{ id: string }>({
      model: "organization",
      data: { name: "Adapter Org", slug, createdAt: new Date() },
    });
    const row = await env.DB.prepare("SELECT clerk_org_id FROM organizations WHERE id = ?").bind(org.id).first<{ clerk_org_id: string | null }>();
    expect(row?.clerk_org_id).toBeTruthy();
  });
});

describe("R6 cross-site request check on /api/v1", () => {
  const preset = { name: "R6", utm_source: "s", utm_medium: "m", utm_campaign: "c" };

  it("a cookie POST from an untrusted Origin is a 403", async () => {
    const user = await createUser();
    const h = await sessionHeaders(user.id);
    const res = await api("/api/v1/utm/presets", { method: "POST", headers: { ...h, Origin: "https://evil.example" }, json: preset });
    expect(res.status).toBe(403);
    expect((await json(res)).detail).toBe("Cross-site request blocked");
  });

  it("a cookie POST without an Origin is a 403", async () => {
    const user = await createUser();
    const { Origin: _drop, ...noOrigin } = await sessionHeaders(user.id);
    const res = await api("/api/v1/utm/presets", { method: "POST", headers: noOrigin, json: preset });
    expect(res.status).toBe(403);
  });

  it("the same cookie POST from the trusted app Origin is not blocked", async () => {
    const user = await createUser();
    const res = await api("/api/v1/utm/presets", { method: "POST", headers: await sessionHeaders(user.id), json: preset });
    expect(res.status).toBe(201);
  });

  it("an X-API-Key POST without an Origin is not blocked", async () => {
    const user = await createUser();
    const key = await createApiKey(user.id);
    const res = await api("/api/v1/utm/presets", { method: "POST", headers: { "X-API-Key": key }, json: preset });
    expect(res.status).toBe(201);
  });
});

describe("Google sign-in", () => {
  const google = { googleClientId: "test-client.apps.googleusercontent.com", googleClientSecret: "test-secret" };

  it("is offered only when the client is configured, with the /api/auth/callback/google redirect", async () => {
    const start = () =>
      api("/api/auth/sign-in/social", { method: "POST", headers: { ...ORIGIN, ...ip() }, json: { provider: "google", callbackURL: "/" } });
    expect((await start()).status).not.toBe(200);

    const s = getSettings(env as unknown as Env);
    const saved = { googleClientId: s.googleClientId, googleClientSecret: s.googleClientSecret };
    Object.assign(s, google);
    try {
      const res = await start();
      expect(res.status).toBe(200);
      const url = new URL((await json(res)).url);
      expect(url.origin).toBe("https://accounts.google.com");
      expect(url.searchParams.get("client_id")).toBe(google.googleClientId);
      expect(url.searchParams.get("redirect_uri")).toBe(`${BASE}/api/auth/callback/google`);
    } finally {
      Object.assign(s, saved);
    }
  });
});

describe("required secrets", () => {
  for (const name of ["STORAGE_UPLOAD_SECRET", "BETTER_AUTH_SECRET", "BETTER_AUTH_URL"]) {
    it(`boot without ${name} fails with a message naming it`, () => {
      expect(() => buildSettings({ ...(env as unknown as Env), [name]: "" } as Env)).toThrow(new RegExp(name));
    });
  }
});

describe("CPU budget", () => {
  it("times one bcryptjs compare at cost 10 inside the Workers pool", async () => {
    const hash = bcrypt.hashSync("cpu-check-password", 10);
    const t0 = performance.now();
    const ok = await bcrypt.compare("cpu-check-password", hash);
    const ms = performance.now() - t0;
    expect(ok).toBe(true);
    console.log(`bcryptjs compare cost 10: ${ms.toFixed(1)} ms (Workers Free CPU limit is 10 ms)`);
  });
});
