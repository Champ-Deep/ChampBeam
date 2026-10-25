/**
 * Port of backend/app/core/security.py: Clerk session-token verification,
 * cb_live_ API keys, the X-Service-Key identity, and org-role guards.
 *
 * FastAPI dependencies become plain async functions taking the Hono context:
 *
 *   Depends(get_current_user)            -> await getCurrentUser(c)        (TokenData | null)
 *   Depends(require_auth)                -> await requireAuth(c)
 *   Depends(require_clerk_auth)          -> await requireClerkAuth(c)
 *   Depends(require_org_member)          -> await requireOrgMember(c)
 *   Depends(require_org_admin)           -> await requireOrgAdmin(c)
 *   Depends(require_org_leader_or_admin) -> await requireOrgLeaderOrAdmin(c)
 */
import { eq } from "drizzle-orm";
import { decodeProtectedHeader, importJWK, jwtVerify, errors as joseErrors, type JWK } from "jose";
import type { Ctx, Settings } from "../env";
import { API_KEY_PREFIX, apiKeys, users } from "../db/schema";
import { HTTPError } from "../lib/errors";
import { enforceLimit } from "../lib/ratelimit";
import { sha256Hex } from "../lib/crypto";
import { diffSeconds, nowIso, parseIso } from "../lib/time";
import * as userService from "../services/user";
import * as orgService from "../services/org";
import * as clerk from "../services/clerk";
import { type Permission, roleHas } from "./permissions";
import { resolveServiceIdentity } from "./serviceAuth";

export interface TokenData {
  userId: string;
  email: string;
  clerkUserId?: string | null;
  /** Clerk org id (org_...) of the active organization, when one is selected. */
  orgId?: string | null;
  /** Normalized role: "admin" | "member" | "leader" | "super_admin" | custom. */
  orgRole?: string | null;
  orgSlug?: string | null;
  /** Local organizations.id of the active org (set only for an active, non-revoked membership). */
  orgUuid?: string | null;
}

/** True when the active org role grants `p`. No org, or API key, means no permission. */
export const can = (u: TokenData, p: Permission): boolean => !!u.orgId && roleHas(u.orgRole, p);
export const isOrgAdmin = (u: TokenData): boolean => can(u, "org.members.manage");
export const isOrgLeader = (u: TokenData): boolean => !!u.orgId && (u.orgRole ?? "").toLowerCase() === "leader";

// ---------------------------------------------------------------------------
// Clerk JWKS (cached per isolate)
// ---------------------------------------------------------------------------

const JWKS_CACHE_TTL_MS = 3_600_000;
let jwksCache: { keys: JWK[] } | null = null;
let jwksFetchedAt = 0;

async function fetchClerkJwks(settings: Settings, forceRefresh = false): Promise<{ keys: JWK[] }> {
  // CLERK_JWKS_JSON pins the key set (tests; or to avoid a Clerk round-trip).
  if (settings.clerkJwksJson) return JSON.parse(settings.clerkJwksJson) as { keys: JWK[] };
  if (!forceRefresh && jwksCache && Date.now() - jwksFetchedAt < JWKS_CACHE_TTL_MS) return jwksCache;
  const resp = await fetch(`${settings.clerkApiUrl.replace(/\/+$/, "")}/v1/jwks`, {
    headers: { Authorization: `Bearer ${settings.clerkSecretKey}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new UpstreamError(`Clerk JWKS HTTP ${resp.status}`);
  jwksCache = (await resp.json()) as { keys: JWK[] };
  jwksFetchedAt = Date.now();
  return jwksCache;
}

class UpstreamError extends Error {}

/** True if the token's authorized party is an origin we serve the SPA from. */
export function azpAuthorized(settings: Settings, azp: string): boolean {
  const origin = azp.replace(/\/+$/, "");
  if (settings.clerkAuthorizedPartiesList.includes(origin)) return true;
  const pattern = settings.corsAllowOriginRegex.trim();
  if (pattern) {
    try {
      const re = new RegExp(`^(?:${pattern})$`);
      return re.test(origin) || re.test(azp);
    } catch {
      console.warn("invalid CORS_ALLOW_ORIGIN_REGEX; ignoring for azp check");
    }
  }
  return false;
}

function normalizeRoleClaim(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw) return null;
  let r = raw.trim();
  if (r.startsWith("org:")) r = r.slice(4);
  return r.toLowerCase() || null;
}

/** (org_id, normalized_role, org_slug) from v2 ("o") or v1 claims. */
export function extractOrgClaims(payload: Record<string, unknown>): [string | null, string | null, string | null] {
  const o = payload.o;
  if (o && typeof o === "object") {
    const oo = o as Record<string, unknown>;
    return [(oo.id as string) ?? null, normalizeRoleClaim(oo.rol), (oo.slg as string) ?? null];
  }
  return [
    (payload.org_id as string) ?? null,
    normalizeRoleClaim(payload.org_role),
    (payload.org_slug as string) ?? null,
  ];
}

const invalidCreds = () =>
  new HTTPError(401, "Could not validate credentials", { "WWW-Authenticate": "Bearer" });

export async function verifyClerkToken(settings: Settings, token: string): Promise<Record<string, unknown>> {
  let kid: string | undefined;
  try {
    kid = decodeProtectedHeader(token).kid;
  } catch {
    throw invalidCreds();
  }
  let jwks = await fetchClerkJwks(settings);
  let jwk = jwks.keys?.find((k) => k.kid === kid);
  if (!jwk) {
    jwks = await fetchClerkJwks(settings, true);
    jwk = jwks.keys?.find((k) => k.kid === kid);
    if (!jwk) throw new HTTPError(401, "Unknown signing key");
  }
  let payload: Record<string, unknown>;
  try {
    const key = await importJWK(jwk, "RS256");
    const issuer = settings.resolvedClerkIssuer;
    const res = await jwtVerify(token, key, { algorithms: ["RS256"], ...(issuer ? { issuer } : {}) });
    payload = res.payload as Record<string, unknown>;
  } catch (err) {
    if (err instanceof joseErrors.JOSEError || err instanceof TypeError) throw invalidCreds();
    throw err;
  }
  const parties = settings.clerkAuthorizedPartiesList;
  const azp = payload.azp;
  if (parties.length && typeof azp === "string" && azp && !azpAuthorized(settings, azp)) {
    throw new HTTPError(401, "Unauthorized party");
  }
  if (!payload.sub) throw new HTTPError(401, "Invalid token: missing sub");
  return payload;
}

// Throttle Clerk profile backfills: clerk_user_id -> last attempt (ms).
const identityAttempts = new Map<string, number>();
const IDENTITY_RETRY_MS = 600_000;

async function maybeBackfillIdentity(c: Ctx, user: userService.User, tokenEmail: string | null): Promise<void> {
  const db = c.var.db;
  if (!userService.hasPlaceholderEmail(user)) return;
  if (tokenEmail) {
    await userService.applyIdentity(db, user, { email: tokenEmail });
    return;
  }
  const clerkId = user.clerkId!;
  const now = Date.now();
  const last = identityAttempts.get(clerkId);
  if (last !== undefined && now - last < IDENTITY_RETRY_MS) return;
  identityAttempts.set(clerkId, now);
  const payload = await clerk.fetchUser(c.var.settings, clerkId);
  if (payload) {
    await userService.applyIdentity(db, user, {
      email: clerk.primaryEmail(payload),
      fullName: clerk.fullName(payload),
    });
  }
}

async function resolveUser(c: Ctx, payload: Record<string, unknown>): Promise<TokenData> {
  const db = c.var.db;
  const clerkUserId = payload.sub as string;
  let [orgId, orgRole, orgSlug] = extractOrgClaims(payload);
  const tokenEmail = typeof payload.email === "string" ? payload.email : null;
  const user = await userService.getOrCreateByClerkId(db, clerkUserId);
  await maybeBackfillIdentity(c, user, tokenEmail);
  let orgUuid: string | null = null;
  if (orgId) {
    const m = await orgService.resolveActiveMembership(db, user.id, orgId, orgRole ?? "member", orgSlug);
    if (m) {
      orgUuid = m.orgUuid;
      orgRole = m.role;
    } else {
      // Revoked: behave exactly as if no organization were selected.
      orgId = orgRole = orgSlug = null;
    }
  }
  return {
    userId: user.id,
    email: user.email ?? "",
    clerkUserId,
    orgId,
    orgRole,
    orgSlug,
    orgUuid,
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
  const bearer = bearerToken(c);
  const serviceKey = opts.allowApiKey ? c.req.header("x-service-key") : undefined;
  if (apiKey === null && bearer === null && !serviceKey) return null;
  try {
    if (serviceKey) return await resolveServiceIdentity(c, serviceKey.trim());
    if (apiKey !== null) return await resolveApiKey(c, apiKey);
    const payload = await verifyClerkToken(c.var.settings, bearer!);
    return await resolveUser(c, payload);
  } catch (err) {
    if (err instanceof HTTPError) throw err;
    if (err instanceof UpstreamError || isNetworkOrDbError(err)) {
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

/** Interactive Clerk session only; API keys are explicitly rejected (key management). */
export async function requireClerkAuth(c: Ctx): Promise<TokenData> {
  if (presentedApiKey(c) !== null) {
    throw new HTTPError(403, "API keys cannot access this endpoint; sign in required");
  }
  const bearer = bearerToken(c);
  const serviceKey = c.req.header("x-service-key");
  if (bearer === null && !serviceKey) {
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

/** Require one explicit permission in the active org. */
export async function requirePermission(c: Ctx, p: Permission): Promise<TokenData> {
  const u = await requireOrgMember(c);
  if (!can(u, p)) throw new HTTPError(403, "You do not have permission to do this.");
  return u;
}
