/**
 * Port of backend/app/core/security.py: Better Auth cookie sessions (replacing Clerk session
 * JWTs), cb_live_ API keys, the X-Service-Key identity, and org-role guards.
 *
 * FastAPI dependencies become plain async functions taking the Hono context:
 *
 *   Depends(get_current_user)            -> await getCurrentUser(c)        (TokenData | null)
 *   Depends(require_auth)                -> await requireAuth(c)
 *   Depends(require_clerk_auth)          -> await requireSessionAuth(c)
 *   Depends(require_org_member)          -> await requireOrgMember(c)
 *   Depends(require_org_admin)           -> await requireOrgAdmin(c)
 *   Depends(require_org_leader_or_admin) -> await requireOrgLeaderOrAdmin(c)
 */
import { and, eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { AppEnv, Ctx } from "../env";
import { trustedOrigins } from "../lib/cors";
import { API_KEY_PREFIX, MEMBERSHIP_ACTIVE, apiKeys, organizationMemberships, organizations, users } from "../db/schema";
import { HTTPError } from "../lib/errors";
import { enforceLimit } from "../lib/ratelimit";
import { sha256Hex } from "../lib/crypto";
import { diffSeconds, nowIso, parseIso } from "../lib/time";
import { type Permission, roleHas } from "./permissions";
import { resolveServiceIdentity } from "./serviceAuth";
import { createAuth, type Auth } from "./betterAuth";
import { isSuperAdmin } from "./superAdmin";

export interface TokenData {
  userId: string;
  email: string;
  clerkUserId?: string | null;
  /** organizations.id of the active organization (set only for an active membership). */
  orgId?: string | null;
  /** Normalized role: "admin" | "member" | "leader" | "super_admin" | custom. */
  orgRole?: string | null;
  orgSlug?: string | null;
  /** Same value as orgId since Better Auth (kept so its many readers need no change). */
  orgUuid?: string | null;
  /** Session identities only: listed in SUPER_ADMIN_EMAILS and verified or Google-linked. */
  isSuperAdmin?: boolean;
}

/** True when the active org role grants `p`. No org, or API key, means no permission. */
export const can = (u: TokenData, p: Permission): boolean => !!u.orgId && roleHas(u.orgRole, p);
export const isOrgAdmin = (u: TokenData): boolean => can(u, "org.members.manage");
export const isOrgLeader = (u: TokenData): boolean => !!u.orgId && (u.orgRole ?? "").toLowerCase() === "leader";

// ---------------------------------------------------------------------------
// Better Auth sessions
// ---------------------------------------------------------------------------

/** The request's Better Auth instance (built once per request: D1 bindings exist only per request). */
export function authOf(c: Ctx): Auth {
  let auth = c.get("auth");
  if (!auth) {
    auth = createAuth(c.env, c.var.db);
    c.set("auth", auth);
  }
  return auth;
}

/** True when the request carries a session cookie (any prefix). Cheap: no DB read for anonymous traffic. */
export const hasSessionCookie = (c: Ctx): boolean => /(?:^|;\s*)(?:__Secure-)?champbeam\.session_token=/.test(c.req.header("cookie") ?? "");

/**
 * R6 CSRF: a cookie session is sent cross-site by the browser, so a cookie-authenticated mutation must
 * carry an Origin we trust. API-key and service-key requests are exempt (no ambient credential).
 */
export const crossSiteGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  const m = c.req.method;
  if (m !== "GET" && m !== "HEAD" && m !== "OPTIONS" && hasSessionCookie(c) && presentedApiKey(c) === null && !c.req.header("x-service-key")) {
    const origin = c.req.header("origin");
    if (!origin || !trustedOrigins(c.var.settings).includes(origin)) throw new HTTPError(403, "Cross-site request blocked");
  }
  await next();
};

async function resolveSession(c: Ctx): Promise<TokenData | null> {
  const session = await authOf(c).api.getSession({ headers: c.req.raw.headers });
  if (!session) return null;
  const { user } = session;
  // Same rule as the API-key and service-key paths: a deactivated account has no session.
  if (user.isActive === false) throw new HTTPError(401, "Account is deactivated");
  const activeOrg = session.session.activeOrganizationId;
  // The membership is read on every request (cookieCache off), so a removal takes effect at once.
  const superAdmin = await isSuperAdmin(c.var.db, c.var.settings, user);
  let m = activeOrg
    ? await c.var.db
        .select({ role: organizationMemberships.role, slug: organizations.slug })
        .from(organizationMemberships)
        .innerJoin(organizations, eq(organizations.id, organizationMemberships.organizationId))
        .where(
          and(
            eq(organizationMemberships.organizationId, activeOrg),
            eq(organizationMemberships.userId, user.id),
            eq(organizationMemberships.status, MEMBERSHIP_ACTIVE),
          ),
        )
        .get()
    : undefined;
  // A super admin acts as admin in whichever org they switched to (POST /admin/act-as), member or not.
  if (!m && superAdmin && activeOrg) {
    const o = await c.var.db.select({ slug: organizations.slug }).from(organizations).where(eq(organizations.id, activeOrg)).get();
    if (o) m = { role: "admin", slug: o.slug };
  }
  return {
    userId: user.id,
    email: user.email ?? "",
    isSuperAdmin: superAdmin,
    clerkUserId: user.clerkId ?? null,
    orgId: m ? activeOrg : null,
    orgRole: m ? m.role.toLowerCase() : null,
    orgSlug: m ? m.slug : null,
    orgUuid: m ? activeOrg : null,
  };
}

// ---------------------------------------------------------------------------
// API keys ("cb_live_...", X-API-Key header or Bearer)
// ---------------------------------------------------------------------------

export const API_KEY_RATE_LIMIT_PER_MINUTE = 120;
const LAST_USED_TOUCH_SECONDS = 60;

function bearerToken(c: Ctx): string | null {
  const h = c.req.header("authorization");
  if (!h) return null;
  const [scheme, ...rest] = h.trim().split(/\s+/);
  if (!scheme || scheme.toLowerCase() !== "bearer" || !rest.length) return null;
  return rest.join(" ");
}

function presentedApiKey(c: Ctx): string | null {
  const x = c.req.header("x-api-key");
  if (x && x.trim()) return x.trim();
  const bearer = bearerToken(c);
  if (bearer && bearer.startsWith(API_KEY_PREFIX)) return bearer;
  return null;
}

export function apiKeyIsActive(k: { revokedAt: string | null; expiresAt: string | null }): boolean {
  if (k.revokedAt) return false;
  const exp = parseIso(k.expiresAt);
  if (exp && exp.getTime() <= Date.now()) return false;
  return true;
}

async function resolveApiKey(c: Ctx, rawKey: string): Promise<TokenData> {
  if (!rawKey.startsWith(API_KEY_PREFIX)) throw new HTTPError(401, "Invalid API key");
  const db = c.var.db;
  const digest = await sha256Hex(rawKey);
  const key = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, digest)).get();
  if (!key || !apiKeyIsActive(key)) throw new HTTPError(401, "Invalid API key");

  await enforceLimit(
    c.env.DB,
    `api_rl:${key.id}`,
    API_KEY_RATE_LIMIT_PER_MINUTE,
    60,
    `API key rate limit exceeded (${API_KEY_RATE_LIMIT_PER_MINUTE} requests/minute)`,
  );

  const user = await db.select().from(users).where(eq(users.id, key.userId)).get();
  if (!user || user.isActive === false) throw new HTTPError(401, "Invalid API key");

  const now = nowIso();
  if (!key.lastUsedAt || diffSeconds(key.lastUsedAt, now) > LAST_USED_TOUCH_SECONDS) {
    await db.update(apiKeys).set({ lastUsedAt: now }).where(eq(apiKeys.id, key.id));
  }
  return { userId: user.id, email: user.email ?? "", clerkUserId: user.clerkId };
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

async function resolveIdentity(c: Ctx, opts: { allowApiKey: boolean }): Promise<TokenData | null> {
  const apiKey = opts.allowApiKey ? presentedApiKey(c) : null;
  const serviceKey = opts.allowApiKey ? c.req.header("x-service-key") : undefined;
  const cookie = hasSessionCookie(c);
  if (apiKey === null && !cookie && !serviceKey) {
    // A bearer that is not an API key was a Clerk session token: there are no bearer sessions now.
    if (bearerToken(c) !== null) throw new HTTPError(401, "Could not validate credentials", { "WWW-Authenticate": "Bearer" });
    return null;
  }
  try {
    if (serviceKey) return await resolveServiceIdentity(c, serviceKey.trim());
    if (apiKey !== null) return await resolveApiKey(c, apiKey);
    return await resolveSession(c);
  } catch (err) {
    if (err instanceof HTTPError) throw err;
    if (isNetworkOrDbError(err)) {
      console.error("auth: upstream/DB failure resolving user", err);
      throw new HTTPError(503, "Auth service temporarily unavailable");
    }
    console.error("auth: unexpected error resolving user", err);
    throw new HTTPError(500, "Internal authentication error");
  }
}

function isNetworkOrDbError(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? "");
  return (
    err instanceof DOMException ||
    /D1_|SQLITE|network|fetch failed|timed out|timeout/i.test(msg)
  );
}

async function memoized(c: Ctx): Promise<TokenData | null> {
  if (c.var.authUser !== undefined) return c.var.authUser;
  const u = await resolveIdentity(c, { allowApiKey: true });
  c.set("authUser", u);
  return u;
}

/** Optional auth: TokenData, or null when no credentials were presented. */
export async function getCurrentUser(c: Ctx): Promise<TokenData | null> {
  return memoized(c);
}

export async function requireAuth(c: Ctx): Promise<TokenData> {
  const u = await memoized(c);
  if (!u) throw new HTTPError(401, "Authentication required", { "WWW-Authenticate": "Bearer" });
  return u;
}

/** Interactive cookie session only; API keys are explicitly rejected (key management). */
export async function requireSessionAuth(c: Ctx): Promise<TokenData> {
  if (presentedApiKey(c) !== null) {
    throw new HTTPError(403, "API keys cannot access this endpoint; sign in required");
  }
  const serviceKey = c.req.header("x-service-key");
  if (!hasSessionCookie(c) && !serviceKey) {
    throw new HTTPError(401, "Authentication required", { "WWW-Authenticate": "Bearer" });
  }
  return requireAuth(c);
}

export async function requireOrgMember(c: Ctx): Promise<TokenData> {
  const u = await requireAuth(c);
  if (!u.orgId) throw new HTTPError(403, "Select an organization to use team features.");
  return u;
}

export async function requireOrgAdmin(c: Ctx): Promise<TokenData> {
  const u = await requireOrgMember(c);
  if (!isOrgAdmin(u)) throw new HTTPError(403, "This action requires an organization admin.");
  return u;
}

export async function requireOrgLeaderOrAdmin(c: Ctx): Promise<TokenData> {
  const u = await requireOrgMember(c);
  if (!can(u, "team.manage")) {
    throw new HTTPError(403, "This action requires a team leader or organization admin.");
  }
  return u;
}

/** Platform super admin, interactive session only (never an API key). */
export async function requireSuperAdmin(c: Ctx): Promise<TokenData> {
  const u = await requireSessionAuth(c);
  if (!u.isSuperAdmin) throw new HTTPError(403, "Super admin only.");
  return u;
}

/** Require one explicit permission in the active org. */
export async function requirePermission(c: Ctx, p: Permission): Promise<TokenData> {
  const u = await requireOrgMember(c);
  if (!can(u, p)) throw new HTTPError(403, "You do not have permission to do this.");
  return u;
}
