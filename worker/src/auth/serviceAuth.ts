/**
 * Port of backend/app/core/service_auth.py: the X-Service-Key lane for trusted
 * backend integrations. Keys come from SERVICE_API_KEYS ("name:key,..."),
 * resolve to service+{name}@championsmail.com, are accepted only on a
 * write-only route allowlist (403 elsewhere) and are rate limited 60/min.
 */
import { and, eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { AppEnv, Ctx, Settings } from "../env";
import { organizationMemberships, organizations, users } from "../db/schema";
import { HTTPError } from "../lib/errors";
import { incrWithTtl, windowIndex } from "../lib/ratelimit";
import { sha256Hex } from "../lib/crypto";
import type { TokenData } from "./security";

export const SERVICE_KEY_RATE_LIMIT_PER_MINUTE = 60;
const UUID = "[0-9a-fA-F-]{36}";

const ALLOWED: [string, RegExp][] = [
  ["POST", /^\/api\/v1\/content\/?$/],
  ["POST", new RegExp(`^/api/v1/content/${UUID}/share/?$`)],
  ["POST", /^\/api\/v1\/utm\/generate\/?$/],
  ["POST", /^\/api\/v1\/pages\/?$/],
  ["POST", /^\/api\/v1\/pages\/upload\/?$/],
  ["PUT", new RegExp(`^/api/v1/pages/${UUID}/?$`)],
  ["PATCH", new RegExp(`^/api/v1/pages/${UUID}/?$`)],
];

const digestCache = new WeakMap<Settings, Promise<Map<string, string>>>();

/** sha256(key) hex -> service name, parsed from SERVICE_API_KEYS. */
function serviceKeyDigestMap(settings: Settings): Promise<Map<string, string>> {
  let p = digestCache.get(settings);
  if (!p) {
    p = (async () => {
      const out = new Map<string, string>();
      for (const pairRaw of settings.serviceApiKeys.split(",")) {
        const pair = pairRaw.trim();
        const idx = pair.indexOf(":");
        if (!pair || idx < 0) continue;
        const name = pair.slice(0, idx).trim();
        const key = pair.slice(idx + 1).trim();
        if (name && key) out.set(await sha256Hex(key), name);
      }
      return out;
    })();
    digestCache.set(settings, p);
  }
  return p;
}

export async function resolveServiceName(settings: Settings, rawKey: string): Promise<string | null> {
  return (await serviceKeyDigestMap(settings)).get(await sha256Hex(rawKey)) ?? null;
}

export function routeAllowed(method: string, path: string): boolean {
  return ALLOWED.some(([m, re]) => m === method && re.test(path));
}

/** Middleware: validates and scopes any request presenting X-Service-Key. */
export const serviceKeyGate: MiddlewareHandler<AppEnv> = async (c, next) => {
  const raw = c.req.header("x-service-key");
  if (!raw || !raw.trim()) return next();
  const name = await resolveServiceName(c.var.settings, raw.trim());
  if (name === null) return c.json({ detail: "Invalid service key" }, 401);
  if (!routeAllowed(c.req.method, new URL(c.req.url).pathname)) {
    return c.json({ detail: "Service keys are not accepted on this endpoint" }, 403);
  }
  const count = await incrWithTtl(c.env.DB, `svc_rl:${name}:${windowIndex(60)}`, 60);
  if (count !== null && count > SERVICE_KEY_RATE_LIMIT_PER_MINUTE) {
    return c.json(
      { detail: `Service key rate limit exceeded (${SERVICE_KEY_RATE_LIMIT_PER_MINUTE} requests/minute)` },
      429,
    );
  }
  return next();
};

/** Resolve a validated service key to its pre-provisioned identity. */
export async function resolveServiceIdentity(c: Ctx, rawKey: string): Promise<TokenData> {
  const name = await resolveServiceName(c.var.settings, rawKey);
  if (name === null) throw new HTTPError(401, "Invalid service key");
  const email = `service+${name}@championsmail.com`;
  const db = c.var.db;
  const user = await db.select().from(users).where(eq(users.email, email)).get();
  if (!user || user.isActive === false) {
    console.error(`service key '${name}' valid but user ${email} is not provisioned`);
    throw new HTTPError(401, "Service identity not provisioned");
  }
  const row = await db
    .select({
      role: organizationMemberships.role,
      clerkOrgId: organizations.clerkOrgId,
      slug: organizations.slug,
      orgUuid: organizations.id,
    })
    .from(organizationMemberships)
    .innerJoin(organizations, eq(organizations.id, organizationMemberships.organizationId))
    .where(and(eq(organizationMemberships.userId, user.id), eq(organizationMemberships.status, "active")))
    .limit(1)
    .get();
  return {
    userId: user.id,
    email: user.email ?? "",
    orgId: row?.clerkOrgId ?? null,
    orgRole: row?.role ?? null,
    orgSlug: row?.slug ?? null,
    orgUuid: row?.orgUuid ?? null,
  };
}
