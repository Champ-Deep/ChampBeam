/**
 * Shared test helpers. Port of backend/tests/conftest.py fixtures.
 *
 * Requests go through the real Worker (`SELF.fetch`) so routing, CORS, auth and
 * error shapes are exercised end to end against a migrated in-memory D1 + R2.
 *
 * Auth in tests, two ways:
 *  - apiKeyHeaders(await createApiKey(userId))   -> X-API-Key (cb_live_...)
 *  - await sessionHeaders(userId, orgId?)        -> a Better Auth session row plus its
 *    signed cookie (BETTER_AUTH_SECRET in vitest.config.ts) and a trusted Origin.
 * clerkToken() remains only to prove a leftover Clerk bearer is refused.
 */
import { env, SELF } from "cloudflare:test";
import { SignJWT, importJWK } from "jose";
import { makeSignature } from "better-auth/crypto";
import clerkKey from "./fixtures/clerk-test-key.json" with { type: "json" };

export const BASE = "https://share.example.com";

/** Rate-limit tests count inside one fixed window: wait out a boundary that is about to pass. */
export async function awayFromWindowEdge(windowSeconds = 600, marginMs = 20_000): Promise<void> {
  const toEdge = windowSeconds * 1000 - (Date.now() % (windowSeconds * 1000));
  if (toEdge < marginMs) await new Promise((r) => setTimeout(r, toEdge + 250));
}

export async function api(path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(init.json);
  }
  const url = path.startsWith("http") ? path : `${BASE}${path}`;
  return SELF.fetch(url, { ...init, headers, body, redirect: "manual" });
}

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const nowIso = () => new Date().toISOString();

export async function createUser(opts: { email?: string; clerkId?: string | null; fullName?: string } = {}) {
  const id = crypto.randomUUID();
  const email = opts.email ?? `user-${id.slice(0, 8)}@example.com`;
  await env.DB.prepare(
    "INSERT INTO users (id, clerk_id, email, full_name, is_active, created_at, updated_at) VALUES (?,?,?,?,1,?,?)",
  )
    .bind(id, opts.clerkId === undefined ? `user_${id.slice(0, 8)}` : opts.clerkId, email, opts.fullName ?? null, nowIso(), nowIso())
    .run();
  return { id, email, clerkId: opts.clerkId === undefined ? `user_${id.slice(0, 8)}` : opts.clerkId };
}

/** Insert an API key for the user; returns the raw "cb_live_..." key. */
export async function createApiKey(userId: string, name = "test"): Promise<string> {
  const raw = `cb_live_${crypto.randomUUID().replace(/-/g, "")}`;
  await env.DB.prepare(
    "INSERT INTO api_keys (id, user_id, name, key_prefix, key_hash, created_at) VALUES (?,?,?,?,?,?)",
  )
    .bind(crypto.randomUUID(), userId, name, raw.slice(0, 12), await sha256Hex(raw), nowIso())
    .run();
  return raw;
}

export const apiKeyHeaders = (raw: string) => ({ "X-API-Key": raw });

/** A user + API key in one step; returns headers ready to send. */
export async function authedUser(opts: { email?: string } = {}) {
  const user = await createUser(opts);
  const key = await createApiKey(user.id);
  return { user, key, headers: apiKeyHeaders(key) };
}

export async function createOrg(clerkOrgId = `org_${crypto.randomUUID().slice(0, 8)}`, name = "Acme") {
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO organizations (id, clerk_org_id, name, slug, created_at, updated_at) VALUES (?,?,?,?,?,?)")
    .bind(id, clerkOrgId, name, `${name.toLowerCase()}-${id.slice(0, 8)}`, nowIso(), nowIso())
    .run();
  return { id, clerkOrgId };
}

export async function addMember(orgId: string, userId: string, role = "member", leaderUserId: string | null = null) {
  await env.DB.prepare(
    "INSERT INTO organization_memberships (id, organization_id, user_id, role, leader_user_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(crypto.randomUUID(), orgId, userId, role, leaderUserId, nowIso(), nowIso())
    .run();
}

/**
 * Sign a Clerk-style session JWT. `org` sets v2 org claims
 * ({ id: "org_...", rol: "org:admin", slg: "acme" }).
 */
export async function clerkToken(claims: {
  sub: string;
  email?: string;
  azp?: string;
  org?: { id: string; rol?: string; slg?: string };
  expiresIn?: string;
}): Promise<string> {
  const key = await importJWK(clerkKey.private, "RS256");
  const payload: Record<string, unknown> = { sub: claims.sub };
  if (claims.email) payload.email = claims.email;
  if (claims.azp) payload.azp = claims.azp;
  if (claims.org) payload.o = claims.org;
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid: clerkKey.private.kid })
    .setIssuedAt()
    .setExpirationTime(claims.expiresIn ?? "5m")
    .sign(key);
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/**
 * Signed-in org user: a users row, a membership with `role` in the org keyed by `clerkOrgId` (created
 * on first use, as the import creates orgs), and a Better Auth session whose active org is that org.
 */
export async function orgSession(opts: { role?: string; clerkOrgId?: string; email?: string } = {}) {
  const sub = `user_${crypto.randomUUID().slice(0, 12)}`;
  const clerkOrgId = opts.clerkOrgId ?? `org_${crypto.randomUUID().slice(0, 8)}`;
  const user = await createUser({ clerkId: sub, email: opts.email ?? `${sub}@example.com` });
  const existing = await env.DB.prepare("SELECT id FROM organizations WHERE clerk_org_id = ?").bind(clerkOrgId).first<{ id: string }>();
  const orgId = existing?.id ?? (await createOrg(clerkOrgId)).id;
  await addMember(orgId, user.id, opts.role ?? "member");
  const headers = await sessionHeaders(user.id, orgId);
  return { sub, clerkOrgId, orgId, headers, userId: user.id as string | null, meStatus: 200 };
}

/**
 * A Better Auth session for `userId`, written straight to the `session` table, and the headers a
 * browser on the app origin sends with it: the signed session cookie plus a trusted Origin (R6).
 */
export async function sessionHeaders(userId: string, activeOrganizationId: string | null = null) {
  const token = crypto.randomUUID().replace(/-/g, "");
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO session (id, token, user_id, expires_at, created_at, updated_at, active_organization_id) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(crypto.randomUUID(), token, userId, now + 7 * 86_400_000, now, now, activeOrganizationId)
    .run();
  const sig = await makeSignature(token, env.BETTER_AUTH_SECRET as string);
  return { Cookie: `__Secure-champbeam.session_token=${encodeURIComponent(`${token}.${sig}`)}`, Origin: BASE };
}

export async function json<T = any>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

export { env };
