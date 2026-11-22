/** Auto-join by verified company email domain (card t_b2ddf964). */
import { describe, expect, it } from "vitest";
import { api, BASE, createUser, env, json } from "./helpers";
import { createAuth } from "../src/auth/betterAuth";
import { getDb } from "../src/db/client";
import type { Env } from "../src/env";
import { member, newOrgId, useRouteTestHooks } from "./orgTestUtils";

useRouteTestHooks();

let ipSeq = 0;
const ip = () => ({ "cf-connecting-ip": `192.0.2.${++ipSeq}` });
const rand = () => crypto.randomUUID().slice(0, 8);
const q = (sql: string, ...b: unknown[]) => env.DB.prepare(sql).bind(...b).first<Record<string, any>>();
const orgOf = async (userId: string) => (await q("SELECT organization_id, role FROM organization_memberships WHERE user_id = ?", userId)) ?? null;
const list = (h: Record<string, string>) => api("/api/v1/org/email-domains", { headers: h });
const add = (h: Record<string, string>, domain: string) => api("/api/v1/org/email-domains", { method: "POST", headers: h, json: { domain } });

/** An org with an admin and one listed company domain unique to this test. */
async function listedOrg() {
  const clerkOrg = newOrgId();
  const admin = await member(clerkOrg, "admin");
  const domain = `co-${rand()}.com`;
  expect((await add(admin.headers, domain)).status).toBe(201);
  return { clerkOrg, admin, domain, orgId: admin.orgId };
}

async function googleUser(email: string, emailVerified: boolean) {
  const ctx = await createAuth(env as unknown as Env, getDb(env.DB)).$context;
  const { user } = (await ctx.internalAdapter.createOAuthUser(
    { email, emailVerified, name: "G User" },
    { providerId: "google", accountId: `g-${rand()}` },
  )) as { user: { id: string } };
  return user.id;
}

async function passwordSignUp(email: string) {
  const res = await api("/api/auth/sign-up/email", { method: "POST", headers: { Origin: BASE, ...ip() }, json: { email, password: "long enough pw", name: "Pw User" } });
  expect(res.status).toBe(200);
  return (await q("SELECT id FROM users WHERE email = ?", email))!.id as string;
}

describe("auto-join on verified company email", () => {
  it("a verified Google user on a listed domain joins as member", async () => {
    const s = await listedOrg();
    const id = await googleUser(`Ann@${s.domain.toUpperCase()}`, true);
    expect(await orgOf(id)).toMatchObject({ organization_id: s.orgId, role: "member" });
  });

  it("an unverified password user on the same domain stays personal, also after a sign-in", async () => {
    const s = await listedOrg();
    const email = `bob@${s.domain}`;
    const id = await passwordSignUp(email);
    expect(await orgOf(id)).toBeNull();
    const signIn = await api("/api/auth/sign-in/email", { method: "POST", headers: { Origin: BASE, ...ip() }, json: { email, password: "long enough pw" } });
    expect(signIn.status).toBe(200);
    expect(await orgOf(id)).toBeNull();
  });

  it("a user verified later joins on their next sign-in", async () => {
    const s = await listedOrg();
    const email = `cat@${s.domain}`;
    const id = await passwordSignUp(email);
    await env.DB.prepare("UPDATE users SET email_verified = 1 WHERE id = ?").bind(id).run();
    const signIn = await api("/api/auth/sign-in/email", { method: "POST", headers: { Origin: BASE, ...ip() }, json: { email, password: "long enough pw" } });
    expect(signIn.status).toBe(200);
    expect(await orgOf(id)).toMatchObject({ organization_id: s.orgId, role: "member" });
  });

  it("matching is exact: a subdomain, a lookalike and an unlisted domain do not join", async () => {
    const s = await listedOrg();
    for (const email of [`d@sub.${s.domain}`, `d@not${s.domain}`, `d@${s.domain}.evil.com`, `d@other-${rand()}.com`]) {
      expect(await orgOf(await googleUser(email, true)), email).toBeNull();
    }
  });

  it("a verified user with a revoked membership is not re-added", async () => {
    const s = await listedOrg();
    const u = await createUser({ email: `eve@${s.domain}` });
    await env.DB.prepare("UPDATE users SET email_verified = 1 WHERE id = ?").bind(u.id).run();
    await env.DB.prepare("INSERT INTO organization_memberships (id, organization_id, user_id, role, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
      .bind(crypto.randomUUID(), s.orgId, u.id, "member", "revoked", new Date().toISOString(), new Date().toISOString()).run();
    const ctx = await createAuth(env as unknown as Env, getDb(env.DB)).$context;
    await ctx.internalAdapter.createSession(u.id);
    expect((await q("SELECT status FROM organization_memberships WHERE user_id = ?", u.id))!.status).toBe("revoked");
  });

  it("a member an admin removes (row deleted) stays out after signing in again", async () => {
    const s = await listedOrg();
    const id = await googleUser(`gus@${s.domain}`, true);
    expect(await orgOf(id)).not.toBeNull();
    // Better Auth removeMember DELETES the row; no tombstone is left behind.
    await env.DB.prepare("DELETE FROM organization_memberships WHERE user_id = ?").bind(id).run();
    const ctx = await createAuth(env as unknown as Env, getDb(env.DB)).$context;
    await ctx.internalAdapter.createSession(id);
    await ctx.internalAdapter.createSession(id);
    expect(await orgOf(id)).toBeNull();
  });

  it("existing members are untouched by listing and unlisting a domain", async () => {
    const s = await listedOrg();
    const old = await member(s.clerkOrg, "leader");
    const before = await orgOf(old.userId);
    expect((await api(`/api/v1/org/email-domains/${s.domain}`, { method: "DELETE", headers: s.admin.headers })).status).toBe(204);
    expect(await orgOf(old.userId)).toEqual(before);
    expect(await orgOf(await googleUser(`fay@${s.domain}`, true))).toBeNull();
  });
});

describe("/api/v1/org/email-domains", () => {
  it("lists, adds (lowercased, idempotent) and removes for an admin", async () => {
    const s = await listedOrg();
    expect((await json(await list(s.admin.headers))).map((d: any) => d.domain)).toEqual([s.domain]);
    const again = await add(s.admin.headers, ` ${s.domain.toUpperCase()} `);
    expect(again.status).toBe(200);
    expect((await json(await list(s.admin.headers))).length).toBe(1);
    expect((await api(`/api/v1/org/email-domains/${s.domain}`, { method: "DELETE", headers: s.admin.headers })).status).toBe(204);
    expect(await json(await list(s.admin.headers))).toEqual([]);
    expect((await api(`/api/v1/org/email-domains/${s.domain}`, { method: "DELETE", headers: s.admin.headers })).status).toBe(404);
  });

  it("public mailbox providers and malformed domains are a 400", async () => {
    const s = await listedOrg();
    for (const d of ["gmail.com", "Outlook.com", "yahoo.com", "icloud.com", "proton.me", "hotmail.com", "*.acme.com", "@acme.com", "acme", "a b.com", ""]) {
      expect((await add(s.admin.headers, d)).status, d).toBe(400);
    }
  });

  it("a non-admin gets 403 on every verb", async () => {
    const s = await listedOrg();
    const rep = await member(s.clerkOrg, "member");
    expect((await list(rep.headers)).status).toBe(403);
    expect((await add(rep.headers, `x-${rand()}.com`)).status).toBe(403);
    expect((await api(`/api/v1/org/email-domains/${s.domain}`, { method: "DELETE", headers: rep.headers })).status).toBe(403);
    expect((await json(await list(s.admin.headers))).length).toBe(1);
  });

  it("a domain belongs to one org: another org's admin gets 409 and cannot delete it", async () => {
    const s = await listedOrg();
    const other = await member(newOrgId(), "admin");
    expect((await add(other.headers, s.domain)).status).toBe(409);
    expect((await api(`/api/v1/org/email-domains/${s.domain}`, { method: "DELETE", headers: other.headers })).status).toBe(404);
    expect((await json(await list(s.admin.headers))).length).toBe(1);
  });

  it("a signed-out caller is refused", async () => {
    expect([401, 403]).toContain((await api("/api/v1/org/email-domains")).status);
    });
});
