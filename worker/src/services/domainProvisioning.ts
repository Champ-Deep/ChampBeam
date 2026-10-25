/**
 * Custom-domain status logic + the scheduled refresh. Port of
 * backend/app/services/domain_provisioning.py (plus `_apply_cf_status` from
 * api/v1/domains.py, shared here because the cron needs it too).
 *
 * Two provisioning paths:
 *  - Cloudflare for SaaS (primary on Cloudflare): the domain has a
 *    `cf_custom_hostname_id`; CF issues the cert and routes the hostname to
 *    the Worker. `applyCfStatus` mirrors CF's status onto the row.
 *  - Self-hosted BYOD (config-gated: PLATFORM_IPV4 + BYOD_CNAME_TARGET):
 *    pending_cname --(DNS resolves to PLATFORM_IPV4)--> pending_ssl
 *    --(host-side provisioner issues vhost+cert, /health reachable)--> active.
 *    Three failed provisioning attempts park the domain in `failed` with the
 *    error surfaced on verification_errors. The nginx/certbot work happens on
 *    the VPS (deploy/provisioner/), which polls the internal provisioning API
 *    and reports results back; a Worker cannot issue certs itself.
 *
 * `refreshPendingDomains` is the 5-minute cron job that replaced the asyncio
 * `domain_provision_loop`: one pass per invocation, CF-for-SaaS refresh first,
 * then the self-hosted sweep when it is enabled.
 *
 * Exports:
 *   MAX_PROVISION_ATTEMPTS (3), AUTO_POLL_MAX_AGE_MS (7 days), MAX_REFRESH_PER_PASS,
 *   CNAME_INSTRUCTIONS, PROVISIONING_MESSAGE
 *   type DomainRow, type DomainStatusFields, type ProvisionOptions
 *   isPlatformSubdomain(hostname, settings)               -> boolean
 *   verifyReachable(hostname, opts?)                      -> Promise<boolean>
 *   dnsPointsHere(hostname, settings, opts?)              -> Promise<boolean>   (DNS-over-HTTPS)
 *   applyLocalStatus(domain, settings, opts?)             -> Promise<void>      (mutates domain)
 *   applyCfStatus(domain, settings, opts?)                -> Promise<void>      (mutates domain)
 *   persistDomainStatus(db, domain)                       -> Promise<void>      (writes the status fields)
 *   refreshCloudflareDomains(settings, db, opts?)         -> Promise<number>    (rows checked)
 *   sweepLocalDomains(settings, db, opts?)                -> Promise<number>    (rows checked)
 *   refreshPendingDomains(env, settings, db, opts?)       -> Promise<void>      (cron entry point)
 *
 * `opts.fetch` injects the HTTP client (CF API, DoH, /health probe);
 * `opts.verifyReachable` / `opts.dnsPointsHere` override the probes outright
 * (the Python tests monkeypatched these module functions).
 */
import { and, asc, eq, gte, inArray, isNotNull, isNull } from "drizzle-orm";
import type { Env, Settings } from "../env";
import type { Db } from "../db/client";
import {
  DOMAIN_STATUS_ACTIVE,
  DOMAIN_STATUS_FAILED,
  DOMAIN_STATUS_PENDING_CNAME,
  DOMAIN_STATUS_PENDING_SSL,
  domains,
} from "../db/schema";
import { nowIso } from "../lib/time";
import { CloudflareError, CloudflareNotConfigured, deriveStatus, getCustomHostname, type FetchFn } from "./cloudflare";

export const MAX_PROVISION_ATTEMPTS = 3;
/** Stop auto-polling DNS for domains the user abandoned (they can still Refresh). */
export const AUTO_POLL_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
/** Bound subrequests per cron pass (each domain costs 1-3 fetches). */
export const MAX_REFRESH_PER_PASS = 25;

export const CNAME_INSTRUCTIONS =
  "Not reachable yet. Add the CNAME record, wait for DNS to propagate, then " +
  "refresh (or just wait — we re-check every few minutes).";
export const PROVISIONING_MESSAGE = "DNS verified. Issuing your SSL certificate — usually under 2 minutes.";

export type DomainRow = typeof domains.$inferSelect;
/** The fields the status functions read/write (a full DomainRow satisfies it). */
export type DomainStatusFields = Pick<
  DomainRow,
  | "id"
  | "hostname"
  | "status"
  | "sslStatus"
  | "verificationErrors"
  | "verifiedAt"
  | "lastCheckedAt"
  | "provisionRequestedAt"
  | "cfCustomHostnameId"
>;

export interface ProvisionOptions {
  fetch?: FetchFn;
  verifyReachable?: (hostname: string) => Promise<boolean>;
  dnsPointsHere?: (hostname: string) => Promise<boolean>;
}

function fetcher(opts?: ProvisionOptions): FetchFn {
  return opts?.fetch ?? ((input, init) => globalThis.fetch(input, init));
}

/**
 * True when hostname is a single-label subdomain of the platform's wildcard
 * base (for example acme.deependhq.com when the base is deependhq.com). Those
 * are covered by the platform wildcard DNS + cert, so they need no per-host
 * certificate provisioning (the Netlify-style path).
 */
export function isPlatformSubdomain(hostname: string, settings: Pick<Settings, "platformSubdomainBase">): boolean {
  const base = (settings.platformSubdomainBase || "").toLowerCase().trim().replace(/^\.+/, "");
  if (!base) return false;
  const suffix = "." + base;
  if (hostname === base || !hostname.endsWith(suffix)) return false;
  const label = hostname.slice(0, -suffix.length);
  return !!label && !label.includes(".");
}

/**
 * Best-effort live check that the hostname actually routes to this backend.
 *
 * Fetches https://<hostname>/health and confirms our health signature. Used so
 * a domain is not marked live until DNS points here and a valid cert exists.
 */
export async function verifyReachable(hostname: string, opts?: ProvisionOptions): Promise<boolean> {
  let resp: Response;
  try {
    resp = await fetcher(opts)(`https://${hostname}/health`, {
      headers: { "User-Agent": "Champbeam-DomainVerify" },
      redirect: "follow",
      signal: AbortSignal.timeout(6_000),
    });
  } catch {
    return false;
  }
  if (resp.status !== 200) return false;
  try {
    const body = (await resp.json()) as { status?: unknown } | null;
    return (body ?? {}).status === "healthy";
  } catch {
    return false;
  }
}

/** Public DoH JSON resolvers, tried in order (the Python resolver used 1.1.1.1 then 8.8.8.8). */
const DOH_RESOLVERS = ["https://cloudflare-dns.com/dns-query", "https://dns.google/resolve"];

interface DohAnswer {
  name?: string;
  type?: number;
  data?: string;
}

/**
 * True when the hostname's A resolution (following CNAMEs) includes the
 * platform's IPv4. Queried against public resolvers (DNS-over-HTTPS) for a
 * customer's-eye view rather than whatever caches sit in front of us.
 */
export async function dnsPointsHere(
  hostname: string,
  settings: Pick<Settings, "platformIpv4">,
  opts?: ProvisionOptions,
): Promise<boolean> {
  if (!settings.platformIpv4) return false;
  const f = fetcher(opts);
  for (const resolver of DOH_RESOLVERS) {
    let body: { Status?: number; Answer?: DohAnswer[] };
    try {
      const url = `${resolver}?name=${encodeURIComponent(hostname)}&type=A`;
      const resp = await f(url, {
        headers: { accept: "application/dns-json" },
        signal: AbortSignal.timeout(5_000),
      });
      if (!resp.ok) continue; // resolver trouble: try the next one
      body = (await resp.json()) as typeof body;
    } catch {
      continue;
    }
    // A definitive answer (incl. NXDOMAIN) from a resolver ends the lookup.
    if (body.Status !== 0) return false;
    const addresses = new Set((body.Answer ?? []).filter((a) => a.type === 1).map((a) => (a.data ?? "").trim()));
    return addresses.has(settings.platformIpv4);
  }
  return false;
}

/**
 * Resolve status for non-Cloudflare domains (mutates `domain` in place).
 *
 * Platform subdomains are live immediately (wildcard DNS + cert cover them).
 * Other domains advance pending_cname -> pending_ssl once their DNS points at
 * the platform, and only turn active once reachable over valid HTTPS.
 */
export async function applyLocalStatus(
  domain: DomainStatusFields,
  settings: Pick<Settings, "platformSubdomainBase" | "platformIpv4" | "localByodEnabled">,
  opts?: ProvisionOptions,
): Promise<void> {
  const reachable = opts?.verifyReachable ?? ((h: string) => verifyReachable(h, opts));
  const pointsHere = opts?.dnsPointsHere ?? ((h: string) => dnsPointsHere(h, settings, opts));

  domain.lastCheckedAt = nowIso();
  if (isPlatformSubdomain(domain.hostname, settings) || (await reachable(domain.hostname))) {
    domain.status = DOMAIN_STATUS_ACTIVE;
    domain.sslStatus = "active";
    if (domain.verifiedAt == null) domain.verifiedAt = nowIso();
    domain.verificationErrors = null;
    return;
  }
  if (settings.localByodEnabled && (await pointsHere(domain.hostname))) {
    domain.status = DOMAIN_STATUS_PENDING_SSL;
    domain.sslStatus = "provisioning";
    if (domain.provisionRequestedAt == null) domain.provisionRequestedAt = nowIso();
    domain.verificationErrors = { message: PROVISIONING_MESSAGE };
    return;
  }
  domain.status = DOMAIN_STATUS_PENDING_CNAME;
  domain.verificationErrors = { message: CNAME_INSTRUCTIONS };
}

/**
 * Mutate `domain` in place with the latest status from Cloudflare.
 *
 * Best-effort: a CF failure leaves the existing local status untouched but
 * records the error on `verification_errors` so the UI can surface it.
 * No-op when the domain isn't CF-managed or CF isn't configured.
 */
export async function applyCfStatus(
  domain: DomainStatusFields,
  settings: Pick<Settings, "cloudflareConfigured" | "cloudflareApiToken" | "cloudflareZoneId">,
  opts?: ProvisionOptions,
): Promise<void> {
  if (!domain.cfCustomHostnameId) return;
  let result: Record<string, unknown>;
  try {
    result = await getCustomHostname(settings, domain.cfCustomHostnameId, opts);
  } catch (err) {
    if (err instanceof CloudflareNotConfigured) return;
    if (err instanceof CloudflareError) {
      domain.verificationErrors = { message: err.message };
      domain.lastCheckedAt = nowIso();
      return;
    }
    throw err;
  }
  const [newStatus, sslStatus] = deriveStatus(result);
  domain.status = newStatus;
  domain.sslStatus = sslStatus;
  domain.verificationErrors = newStatus !== DOMAIN_STATUS_FAILED ? null : { cf: result };
  domain.lastCheckedAt = nowIso();
  if (newStatus === DOMAIN_STATUS_ACTIVE && domain.verifiedAt == null) domain.verifiedAt = nowIso();
}

/** Write back the fields applyLocalStatus / applyCfStatus may have changed. */
export async function persistDomainStatus(db: Db, domain: DomainStatusFields): Promise<void> {
  await db
    .update(domains)
    .set({
      status: domain.status,
      sslStatus: domain.sslStatus,
      verificationErrors: domain.verificationErrors ?? null,
      verifiedAt: domain.verifiedAt,
      lastCheckedAt: domain.lastCheckedAt,
      provisionRequestedAt: domain.provisionRequestedAt,
    })
    .where(eq(domains.id, domain.id));
}

const PENDING = [DOMAIN_STATUS_PENDING_CNAME, DOMAIN_STATUS_PENDING_SSL];

function cutoffIso(): string {
  return new Date(Date.now() - AUTO_POLL_MAX_AGE_MS).toISOString();
}

/** Refresh pending CF-for-SaaS domains from the CF API. Returns rows checked. */
export async function refreshCloudflareDomains(settings: Settings, db: Db, opts?: ProvisionOptions): Promise<number> {
  if (!settings.cloudflareConfigured) return 0;
  const rows = await db
    .select()
    .from(domains)
    .where(
      and(inArray(domains.status, PENDING), isNotNull(domains.cfCustomHostnameId), gte(domains.createdAt, cutoffIso())),
    )
    .orderBy(asc(domains.lastCheckedAt)) // NULLs first in SQLite: never-checked rows go first
    .limit(MAX_REFRESH_PER_PASS);
  for (const domain of rows) {
    const previous = domain.status;
    await applyCfStatus(domain, settings, opts);
    await persistDomainStatus(db, domain);
    if (domain.status !== previous) {
      console.log(`domain ${domain.hostname} advanced ${previous} -> ${domain.status}`);
    }
  }
  return rows.length;
}

/** One pass of the self-hosted BYOD sweep (was `_sweep_once`). Returns rows checked. */
export async function sweepLocalDomains(settings: Settings, db: Db, opts?: ProvisionOptions): Promise<number> {
  if (!settings.localByodEnabled) return 0;
  const rows = await db
    .select()
    .from(domains)
    .where(and(inArray(domains.status, PENDING), isNull(domains.cfCustomHostnameId), gte(domains.createdAt, cutoffIso())))
    .orderBy(asc(domains.lastCheckedAt))
    .limit(MAX_REFRESH_PER_PASS);
  for (const domain of rows) {
    const previous = domain.status;
    await applyLocalStatus(domain, settings, opts);
    await persistDomainStatus(db, domain);
    if (domain.status !== previous) {
      console.log(`domain ${domain.hostname} advanced ${previous} -> ${domain.status}`);
    }
  }
  return rows.length;
}

/**
 * Cron entry point (every 5 minutes; replaces `domain_provision_loop`):
 * auto-advance pending domains so the customer flow is add domain -> point
 * DNS -> wait, with no manual refresh. Each half is isolated so one failing
 * doesn't starve the other.
 */
export async function refreshPendingDomains(
  _env: Env,
  settings: Settings,
  db: Db,
  opts?: ProvisionOptions,
): Promise<void> {
  try {
    await refreshCloudflareDomains(settings, db, opts);
  } catch (err) {
    console.error("cloudflare domain refresh failed", err);
  }
  try {
    await sweepLocalDomains(settings, db, opts);
  } catch (err) {
    console.error("domain provision sweep failed", err);
  }
}
