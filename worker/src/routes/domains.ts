/**
 * Port of backend/app/api/v1/domains.py — mounted at /api/v1/domains.
 *
 * Domain management endpoints: Bring-Your-Own-Domain for short links, plus
 * one-click procurement through Cloudflare Registrar.
 */
import { Hono } from "hono";
import { and, count, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { AppEnv, Ctx, Settings } from "../env";
import { requireAuth } from "../auth/security";
import { isUniqueViolation } from "../db/client";
import {
  DOMAIN_STATUS_ACTIVE,
  DOMAIN_STATUS_PENDING_CNAME,
  domains,
  linkClicks,
} from "../db/schema";
import { httpError } from "../lib/errors";
import { parseJson, parseQuery, qBool, qInt } from "../lib/validate";
import { isoUtc, nowIso, toStored } from "../lib/time";
import * as cloudflare from "../services/cloudflare";
import * as registrar from "../services/cloudflareRegistrar";
import {
  applyCfStatus,
  applyLocalStatus,
  isPlatformSubdomain,
  persistDomainStatus,
  type DomainRow,
} from "../services/domainProvisioning";

export const router = new Hono<AppEnv>({ strict: false });

// ============================================================================
// Schemas
// ============================================================================

const DomainCreate = z.object({ hostname: z.string().min(3).max(253) });

const DomainCheckRequest = z.object({ domains: z.array(z.string()).min(1).max(20) });

const DomainPurchaseRequest = z.object({
  // The domain to register, e.g. "acme.com".
  domain: z.string().min(3).max(253),
  // The hostname to serve links from. Defaults to "track.<domain>". Must be
  // the domain itself or a subdomain of it.
  hostname: z.string().nullish(),
  auto_renew: z.boolean().default(false),
});

// ============================================================================
// Helpers
// ============================================================================

// RFC-1035-ish: labels of 1-63 chars, alphanumeric + hyphen, no leading/trailing
// hyphen, separated by dots, total length <= 253. Allows internationalized
// domain names only in their punycode form (xn--…).
const HOSTNAME_RE = /^(?=.{1,253}$)(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))+$/;

function normalizeHostname(raw: string | null | undefined): string {
  let h = (raw ?? "").trim().toLowerCase();
  // Strip a trailing dot users might type out of habit.
  if (h.endsWith(".")) h = h.slice(0, -1);
  return h;
}

function validateHostname(settings: Settings, hostname: string): void {
  if (!HOSTNAME_RE.test(hostname)) httpError(400, "Invalid hostname format.");
  if (settings.isPlatformHost(hostname)) httpError(400, "This hostname is reserved by the platform.");
  // Reject things like "localhost" or single-label hosts that crept through.
  if (!hostname.includes(".")) httpError(400, "Hostname must include a domain.");
}

function cnameTarget(settings: Settings): string | null {
  return settings.cloudflareCnameTarget || settings.byodCnameTarget || null;
}

function toResponse(settings: Settings, d: DomainRow) {
  return {
    id: d.id,
    hostname: d.hostname,
    status: d.status,
    ssl_status: d.sslStatus ?? null,
    verification_errors: d.verificationErrors ?? null,
    is_primary: !!d.isPrimary,
    created_at: isoUtc(d.createdAt) ?? "",
    verified_at: isoUtc(d.verifiedAt),
    last_checked_at: isoUtc(d.lastCheckedAt),
    // Setup instructions, included on every response so the UI can show them
    // for any domain still in pending_cname / pending_ssl.
    cname_target: cnameTarget(settings),
    cloudflare_managed: !!d.cfCustomHostnameId,
    // Procurement metadata (NULL for bring-your-own-domain rows).
    procured: d.registrar != null,
    registrar: d.registrar ?? null,
    registration_status: d.registrationStatus ?? null,
    auto_renew: !!d.autoRenew,
    registration_price: d.registrationPrice ?? null,
    domain_expires_at: isoUtc(d.domainExpiresAt),
  };
}

/** Lenient UUID parse (like Python's UUID()): canonical lowercase, or null. */
function canonicalUuid(v: string): string | null {
  let s = v.trim().toLowerCase();
  if (s.startsWith("urn:uuid:")) s = s.slice(9);
  s = s.replace(/^\{|\}$/g, "").replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/.test(s)) return null;
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

async function getOwnedDomain(c: Ctx, userId: string): Promise<DomainRow> {
  const id = canonicalUuid(c.req.param("domain_id") ?? "");
  if (!id) httpError(400, "Invalid domain ID.");
  const d = await c.var.db
    .select()
    .from(domains)
    .where(and(eq(domains.id, id), eq(domains.userId, userId)))
    .get();
  if (!d) httpError(404, "Domain not found.");
  return d;
}

async function hostnameTaken(c: Ctx, hostname: string): Promise<boolean> {
  const row = await c.var.db.select({ id: domains.id }).from(domains).where(eq(domains.hostname, hostname)).get();
  return row != null;
}

async function isFirstDomain(c: Ctx, userId: string): Promise<boolean> {
  const row = await c.var.db.select({ n: count() }).from(domains).where(eq(domains.userId, userId)).get();
  return (row?.n ?? 0) === 0;
}

async function insertDomain(c: Ctx, values: typeof domains.$inferInsert): Promise<DomainRow> {
  try {
    const [row] = await c.var.db.insert(domains).values(values).returning();
    return row;
  } catch (err) {
    // Lost a race with a concurrent create of the same hostname.
    if (isUniqueViolation(err)) httpError(409, "This hostname is already registered.");
    throw err;
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ============================================================================
// Endpoints
// ============================================================================

/** List the authenticated user's custom domains. */
router.get("/", async (c) => {
  const user = await requireAuth(c);
  const rows = await c.var.db
    .select()
    .from(domains)
    .where(eq(domains.userId, user.userId))
    .orderBy(desc(domains.createdAt))
    .all();
  return c.json(rows.map((d) => toResponse(c.var.settings, d)));
});

/** Which custom-domain modes the deployment offers, for the Settings UI. */
router.get("/config", async (c) => {
  await requireAuth(c);
  const s = c.var.settings;
  const base = (s.platformSubdomainBase || "").trim().replace(/^\.+/, "");
  return c.json({
    subdomain_enabled: !!base,
    platform_subdomain_base: base || null,
    byod_enabled: s.cloudflareConfigured || s.localByodEnabled,
    cname_target: cnameTarget(s),
    procurement_enabled: s.cloudflareRegistrarConfigured,
  });
});

/** Add a custom hostname. Provisions a CF Custom Hostname when configured. */
router.post("/", async (c) => {
  const user = await requireAuth(c);
  const data = await parseJson(c, DomainCreate);
  const settings = c.var.settings;
  const hostname = normalizeHostname(data.hostname);
  validateHostname(settings, hostname);

  // Global hostname uniqueness, a domain can only be owned by one account.
  if (await hostnameTaken(c, hostname)) httpError(409, "This hostname is already registered.");

  let cfId: string | null = null;
  let status = DOMAIN_STATUS_PENDING_CNAME;
  let sslStatus: string | null = null;

  if (isPlatformSubdomain(hostname, settings)) {
    // Netlify-style: a subdomain of our own wildcard zone. The platform
    // wildcard DNS + cert already cover it, so mark it active with no
    // per-host provisioning.
    status = DOMAIN_STATUS_ACTIVE;
    sslStatus = "active";
  } else if (settings.cloudflareConfigured) {
    try {
      const result = await cloudflare.createCustomHostname(settings, hostname);
      cfId = result.id ?? null;
      [status, sslStatus] = cloudflare.deriveStatus(result);
    } catch (err) {
      if (!(err instanceof cloudflare.CloudflareError)) throw err;
      console.error(`CF create_custom_hostname failed for ${hostname}`, err);
      httpError(502, `Cloudflare error: ${err.message}`);
    }
  } else {
    // External custom domain with no Cloudflare for SaaS configured. Do NOT
    // mark it active: it is not reachable until DNS points here and a cert is
    // issued. Keep it pending and let Refresh verify real reachability, so the
    // UI never shows a domain as live when it would not actually connect.
    status = DOMAIN_STATUS_PENDING_CNAME;
  }

  // First domain becomes primary automatically.
  const isFirst = await isFirstDomain(c, user.userId);
  const now = nowIso();
  const domain = await insertDomain(c, {
    id: crypto.randomUUID(),
    userId: user.userId,
    hostname,
    status,
    sslStatus,
    cfCustomHostnameId: cfId,
    isPrimary: isFirst,
    createdAt: now,
    verifiedAt: status === DOMAIN_STATUS_ACTIVE ? now : null,
    lastCheckedAt: cfId ? now : null,
  });
  return c.json(toResponse(settings, domain), 201);
});

/** Diagnostic snapshot of the user's domains and CF provisioning state.
 *
 * For each non-active domain, re-polls Cloudflare so a stuck row can be
 * diagnosed without having to refresh each one in the UI. The CF env vars
 * (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ZONE_ID, CLOUDFLARE_CNAME_TARGET) must all
 * be set for this to do useful work; otherwise each row reports
 * cf_status: 'not_configured'.
 */
router.get("/health", async (c) => {
  const user = await requireAuth(c);
  const settings = c.var.settings;
  const cfConfigured = settings.cloudflareConfigured;
  const rows = await c.var.db
    .select()
    .from(domains)
    .where(eq(domains.userId, user.userId))
    .orderBy(desc(domains.createdAt))
    .all();

  const items: Record<string, unknown>[] = [];
  for (const d of rows) {
    const item: Record<string, unknown> = {
      id: d.id,
      hostname: d.hostname,
      status: d.status,
      is_primary: !!d.isPrimary,
      cf_managed: !!d.cfCustomHostnameId,
      ssl_status: d.sslStatus ?? null,
      verification_errors: d.verificationErrors ?? null,
    };
    if (d.status !== DOMAIN_STATUS_ACTIVE && d.cfCustomHostnameId && cfConfigured) {
      try {
        const cf = await cloudflare.getCustomHostname(settings, d.cfCustomHostnameId);
        item.cf_status = cf.status ?? null;
        item.cf_ssl = (cf.ssl || {}).status ?? null;
      } catch (err) {
        if (!(err instanceof cloudflare.CloudflareError)) throw err;
        item.cf_status = "error";
        item.cf_error = err.message;
      }
    } else if (!cfConfigured) {
      item.cf_status = "not_configured";
    }
    items.push(item);
  }

  return c.json({
    cloudflare_configured: cfConfigured,
    cname_target: settings.cloudflareCnameTarget || null,
    domains: items,
  });
});

// ============================================================================
// Domain procurement (Cloudflare Registrar) — search, check, one-click buy
// ============================================================================

function normalizeSearchItem(item: Record<string, any>) {
  const pricing = item.pricing || {};
  return {
    name: item.name ?? "",
    available: !!item.registrable,
    currency: pricing.currency ?? null,
    registration_cost: pricing.registration_cost ?? null,
    renewal_cost: pricing.renewal_cost ?? null,
    reason: item.reason ?? null,
  };
}

function registrarFailure(err: unknown): never {
  if (err instanceof registrar.RegistrarNotConfigured) httpError(503, err.message);
  if (err instanceof registrar.RegistrarError) httpError(502, `Registrar error: ${err.message}`);
  throw err;
}

/** Suggest registrable domains for a keyword (Cloudflare Registrar). */
router.get("/search", async (c) => {
  await requireAuth(c);
  const q = parseQuery(
    c,
    z.object({
      q: z.string().min(1).max(63),
      limit: qInt(20, { ge: 1, le: 40 }),
    }),
  );
  let items: Record<string, any>[];
  try {
    items = await registrar.search(c.var.settings, q.q, q.limit);
  } catch (err) {
    registrarFailure(err);
  }
  return c.json(items.map(normalizeSearchItem));
});

/** Check exact availability + price for specific domains. */
router.post("/check", async (c) => {
  await requireAuth(c);
  const data = await parseJson(c, DomainCheckRequest);
  const names = data.domains.map(normalizeHostname);
  let items: Record<string, any>[];
  try {
    items = await registrar.check(c.var.settings, names);
  } catch (err) {
    registrarFailure(err);
  }
  return c.json(items.map(normalizeSearchItem));
});

/** Register a domain and wire it up to serve links — the one-click path.
 *
 * Registers via Cloudflare Registrar, then best-effort provisions the link
 * hostname: a Custom Hostname (cert) when Cloudflare-for-SaaS is configured,
 * and a CNAME on the freshly created zone pointing at the platform target.
 * Each wiring step degrades gracefully to a pending status with instructions
 * rather than failing the purchase.
 */
router.post("/purchase", async (c) => {
  const user = await requireAuth(c);
  const data = await parseJson(c, DomainPurchaseRequest);
  const settings = c.var.settings;

  const domainName = normalizeHostname(data.domain);
  validateHostname(settings, domainName);
  const hostname = data.hostname ? normalizeHostname(data.hostname) : `track.${domainName}`;
  validateHostname(settings, hostname);
  if (hostname !== domainName && !hostname.endsWith("." + domainName)) {
    httpError(400, "hostname must be the domain or a subdomain of it.");
  }

  if (await hostnameTaken(c, hostname)) httpError(409, "This hostname is already registered.");

  // 1) Register the domain (real money — only fires when configured).
  const contacts = settings.cloudflareRegistrantEmail
    ? { registrant: { email: settings.cloudflareRegistrantEmail } }
    : null;
  let result: Record<string, any>;
  try {
    result = await registrar.register(settings, domainName, { autoRenew: data.auto_renew, contacts });
  } catch (err) {
    if (err instanceof registrar.RegistrarError) console.error(`registrar register failed for ${domainName}`, err);
    registrarFailure(err);
  }

  const regState = registrar.deriveRegistrationState(result);
  if (regState === "failed" || regState === "blocked") httpError(502, `Registration ${regState}.`);
  const regCtx: Record<string, any> = (result.context || {}).registration || {};

  // 2) Wire the link hostname (best-effort).
  let cfId: string | null = null;
  let status = DOMAIN_STATUS_PENDING_CNAME;
  let sslStatus: string | null = null;
  if (settings.cloudflareConfigured) {
    try {
      const ch = await cloudflare.createCustomHostname(settings, hostname);
      cfId = ch.id ?? null;
      [status, sslStatus] = cloudflare.deriveStatus(ch);
    } catch (err) {
      if (!(err instanceof cloudflare.CloudflareError)) throw err;
      console.warn(`CF custom hostname wiring failed for ${hostname}`, err);
    }
  }

  if (hostname !== domainName && settings.cloudflareCnameTarget) {
    try {
      const zoneId = await registrar.findZoneId(settings, domainName);
      if (zoneId) await registrar.createCname(settings, zoneId, hostname, settings.cloudflareCnameTarget);
    } catch (err) {
      if (!(err instanceof registrar.RegistrarError)) throw err;
      console.warn(`CNAME auto-wire failed for ${hostname}`, err);
    }
  }

  const isFirst = await isFirstDomain(c, user.userId);
  const now = nowIso();
  const domain = await insertDomain(c, {
    id: crypto.randomUUID(),
    userId: user.userId,
    hostname,
    status,
    sslStatus,
    cfCustomHostnameId: cfId,
    isPrimary: isFirst,
    createdAt: now,
    verifiedAt: status === DOMAIN_STATUS_ACTIVE ? now : null,
    lastCheckedAt: cfId ? now : null,
    registrar: "cloudflare_registrar",
    registrationStatus: regCtx.status || regState,
    autoRenew: "auto_renew" in regCtx ? !!regCtx.auto_renew : data.auto_renew,
    registrationPrice: regCtx.price != null ? String(regCtx.price) : null,
    domainExpiresAt: regCtx.expires_at ? toStored(String(regCtx.expires_at)) : null,
  });
  return c.json(toResponse(settings, domain), 201);
});

/** Re-poll Cloudflare (or the local reachability checks) for the latest status. */
router.post("/:domain_id/refresh", async (c) => {
  const user = await requireAuth(c);
  const settings = c.var.settings;
  const domain = await getOwnedDomain(c, user.userId);
  if (domain.cfCustomHostnameId) await applyCfStatus(domain, settings);
  else await applyLocalStatus(domain, settings);
  await persistDomainStatus(c.var.db, domain);
  return c.json(toResponse(settings, domain));
});

/** Mark this domain as the user's primary (used as default for new links). */
router.post("/:domain_id/set-primary", async (c) => {
  const user = await requireAuth(c);
  const domain = await getOwnedDomain(c, user.userId);
  if (domain.status !== DOMAIN_STATUS_ACTIVE) httpError(400, "Only active domains can be set as primary.");
  const db = c.var.db;
  await db.batch([
    db.update(domains).set({ isPrimary: false }).where(eq(domains.userId, user.userId)),
    db.update(domains).set({ isPrimary: true }).where(eq(domains.id, domain.id)),
  ]);
  domain.isPrimary = true;
  return c.json(toResponse(c.var.settings, domain));
});

/** Delete a domain. Refuses if links still reference it unless force=true. */
router.delete("/:domain_id", async (c) => {
  const user = await requireAuth(c);
  const { force } = parseQuery(c, z.object({ force: qBool(false) }));
  const settings = c.var.settings;
  const db = c.var.db;
  const domain = await getOwnedDomain(c, user.userId);

  if (!force) {
    const row = await db.select({ n: count() }).from(linkClicks).where(eq(linkClicks.domainId, domain.id)).get();
    const n = row?.n ?? 0;
    if (n > 0) {
      httpError(409, `${n} link(s) still use this domain. Pass force=true to delete anyway.`);
    }
  }

  if (domain.cfCustomHostnameId) {
    try {
      await cloudflare.deleteCustomHostname(settings, domain.cfCustomHostnameId);
    } catch (err) {
      if (err instanceof cloudflare.CloudflareError) {
        // Continue with local delete, CF cleanup can be done manually.
        console.warn(`CF delete_custom_hostname failed for ${domain.hostname}: ${errMessage(err)}`);
      } else if (!(err instanceof cloudflare.CloudflareNotConfigured)) {
        throw err;
      }
    }
  }

  await db.delete(domains).where(eq(domains.id, domain.id));
  return c.body(null, 204);
});
