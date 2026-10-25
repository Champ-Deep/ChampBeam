/**
 * Worker bindings + configuration. Port of backend/app/core/config.py.
 *
 * Every Python `Settings` field is read from the same-named env var (UPPER_CASE)
 * so existing deployment env carries over. Fields that only made sense off
 * Cloudflare are gone: Postgres/Redis/Mongo URLs (-> D1 + rate_counters),
 * local-disk/GridFS storage (-> R2), MaxMind .mmdb paths (-> request.cf geo).
 */
import type { Context } from "hono";
import type { Db } from "./db/client";
import type { TokenData } from "./auth/security";

export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  ASSETS?: Fetcher;
  [key: string]: unknown;
}

export type AppEnv = {
  Bindings: Env;
  Variables: {
    settings: Settings;
    db: Db;
    /** Memoized auth result for this request (undefined = not resolved yet). */
    authUser?: TokenData | null;
    /** True when this request hit a share-only host (no control plane served). */
    sharePlane?: boolean;
  };
};

export type Ctx = Context<AppEnv>;

function str(env: Env, name: string, def = ""): string {
  const v = env[name];
  return typeof v === "string" ? v : v == null ? def : String(v);
}

function int(env: Env, name: string, def: number): number {
  const v = str(env, name);
  const n = v ? Number.parseInt(v, 10) : Number.NaN;
  return Number.isFinite(n) ? n : def;
}

function float(env: Env, name: string, def: number): number {
  const v = str(env, name);
  const n = v ? Number.parseFloat(v) : Number.NaN;
  return Number.isFinite(n) ? n : def;
}

function bool(env: Env, name: string, def: boolean): boolean {
  const v = str(env, name).trim().toLowerCase();
  if (!v) return def;
  return ["1", "true", "yes", "on"].includes(v);
}

function splitCsv(v: string): string[] {
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function hostnameOf(url: string): string {
  try {
    return url ? new URL(url).hostname.toLowerCase() : "";
  } catch {
    return "";
  }
}

export function buildSettings(env: Env) {
  const s = {
    appName: str(env, "APP_NAME", "Champbeam"),
    appVersion: str(env, "APP_VERSION", "1.0.0"),
    debug: bool(env, "DEBUG", true),
    environment: str(env, "ENVIRONMENT", "development"),
    apiV1Prefix: "/api/v1",

    // Clerk
    clerkSecretKey: str(env, "CLERK_SECRET_KEY"),
    clerkPublishableKey: str(env, "CLERK_PUBLISHABLE_KEY"),
    clerkIssuer: str(env, "CLERK_ISSUER"),
    clerkAuthorizedParties: str(env, "CLERK_AUTHORIZED_PARTIES"),
    clerkWebhookSecret: str(env, "CLERK_WEBHOOK_SECRET"),
    clerkApiUrl: str(env, "CLERK_API_URL", "https://api.clerk.com"),
    /** Optional pinned JWKS (JSON). When set, Clerk's /v1/jwks is not fetched. */
    clerkJwksJson: str(env, "CLERK_JWKS_JSON"),

    frontendUrl: str(env, "FRONTEND_URL", "http://localhost:5173"),
    corsAllowOrigins: str(env, "CORS_ALLOW_ORIGINS"),
    corsAllowOriginRegex: str(env, "CORS_ALLOW_ORIGIN_REGEX"),

    redirectBaseUrl: str(env, "REDIRECT_BASE_URL"),
    platformRedirectHost: str(env, "PLATFORM_REDIRECT_HOST"),
    platformSubdomainBase: str(env, "PLATFORM_SUBDOMAIN_BASE"),
    /**
     * Dedicated sharing origin(s), e.g. "share.champbeam.com". Hosted content is
     * untrusted: it is served from these hosts, which carry no signed-in control
     * plane (no SPA, no /api/v1) and so share no cookies with it. Empty = not
     * configured (legacy single-origin behaviour).
     */
    shareOriginHosts: str(env, "SHARE_ORIGIN_HOSTS"),

    // Cloudflare for SaaS + Registrar
    cloudflareApiToken: str(env, "CLOUDFLARE_API_TOKEN"),
    cloudflareZoneId: str(env, "CLOUDFLARE_ZONE_ID"),
    cloudflareCnameTarget: str(env, "CLOUDFLARE_CNAME_TARGET"),
    cloudflareAccountId: str(env, "CLOUDFLARE_ACCOUNT_ID"),
    cloudflareRegistrantEmail: str(env, "CLOUDFLARE_REGISTRANT_EMAIL"),

    // Self-hosted BYOD path (kept for parity; on Cloudflare prefer CF for SaaS)
    platformIpv4: str(env, "PLATFORM_IPV4"),
    byodCnameTarget: str(env, "BYOD_CNAME_TARGET"),
    provisionerToken: str(env, "PROVISIONER_TOKEN"),

    serviceApiKeys: str(env, "SERVICE_API_KEYS"),

    /** Signed "link opened" webhook for contact-bound links. Both must be set, else it is off. */
    openWebhookUrl: str(env, "OPEN_WEBHOOK_URL"),
    openWebhookSecret: str(env, "OPEN_WEBHOOK_SECRET"),

    pagesMaxBytes: int(env, "PAGES_MAX_BYTES", 2 * 1024 * 1024),
    pagesInjectMaxBytes: int(env, "PAGES_INJECT_MAX_BYTES", 5 * 1024 * 1024),
    pagesVersionsKeep: int(env, "PAGES_VERSIONS_KEEP", 10),
    pagesRevisitWindowS: int(env, "PAGES_REVISIT_WINDOW_S", 1800),
    /** Flag for the hosted-HTML CSP sandbox (D3). Off = no page is sandboxed and new pages are not marked. */
    htmlSandbox: bool(env, "HTML_SANDBOX", true),

    champvaultUrl: str(env, "CHAMPVAULT_URL"),
    champvaultApiKey: str(env, "CHAMPVAULT_API_KEY"),

    // R2. The FILES binding always works; these optional S3 credentials enable
    // presigned PUT/GET (browser <-> R2 directly, no Worker body-size limit).
    r2AccountId: str(env, "R2_ACCOUNT_ID"),
    r2AccessKeyId: str(env, "R2_ACCESS_KEY_ID"),
    r2SecretAccessKey: str(env, "R2_SECRET_ACCESS_KEY"),
    r2BucketName: str(env, "R2_BUCKET_NAME") || str(env, "STORAGE_PUBLIC_BUCKET_NAME", "champbeam-files"),
    /** Max bytes accepted when uploads stream THROUGH the Worker (plan limit: 100 MB on Free/Pro). */
    workerUploadMaxBytes: int(env, "WORKER_UPLOAD_MAX_BYTES", 100 * 1024 * 1024),

    maxBytesPerUser: int(env, "MAX_BYTES_PER_USER", 5 * 1024 * 1024 * 1024),
    storageUploadSecret: str(env, "STORAGE_UPLOAD_SECRET"),
    anonFileTtlSeconds: int(env, "ANON_FILE_TTL_SECONDS", 24 * 3600),

    // Geo. Primary source is request.cf (free, on every request). The MaxMind
    // web service / IPinfo remain optional enrichers (plain HTTPS calls).
    maxmindAccountId: str(env, "MAXMIND_ACCOUNT_ID"),
    maxmindLicenseKey: str(env, "MAXMIND_LICENSE_KEY"),
    maxmindWsHost: str(env, "MAXMIND_WS_HOST", "geoip.maxmind.com"),
    maxmindWsEndpoint: str(env, "MAXMIND_WS_ENDPOINT", "insights"),
    maxmindUnitPriceUsd: float(env, "MAXMIND_UNIT_PRICE_USD", 0),
    maxmindCreditWarnThreshold: int(env, "MAXMIND_CREDIT_WARN_THRESHOLD", 5000),
    maxmindCreditCritThreshold: int(env, "MAXMIND_CREDIT_CRIT_THRESHOLD", 1000),
    companyIntelProvider: str(env, "COMPANY_INTEL_PROVIDER", "asn"),
    ipinfoApiToken: str(env, "IPINFO_API_TOKEN"),
  };

  const platformRedirectHosts = new Set<string>();
  for (const h of splitCsv(s.platformRedirectHost)) platformRedirectHosts.add(h.toLowerCase());
  const derived = hostnameOf(s.redirectBaseUrl);
  if (derived) platformRedirectHosts.add(derived);
  const shareHosts = splitCsv(s.shareOriginHosts).map((h) => h.toLowerCase());
  // A share origin is a platform-bucket host: same short codes and slugs resolve there.
  for (const h of shareHosts) platformRedirectHosts.add(h);

  return {
    ...s,

    /** Primary platform-default host (first of PLATFORM_REDIRECT_HOST, else REDIRECT_BASE_URL's). */
    resolvedPlatformRedirectHost:
      splitCsv(s.platformRedirectHost)[0]?.toLowerCase() ?? hostnameOf(s.redirectBaseUrl),
    platformRedirectHosts,
    shareHosts,
    /** Host new shares are minted on when no domain is chosen. */
    resolvedShareHost: shareHosts[0] ?? "",
    isShareOrigin(this: { shareHosts: string[] }, host: string | null | undefined): boolean {
      return this.shareHosts.includes((host ?? "").toLowerCase().trim());
    },
    isPlatformHost(host: string | null | undefined): boolean {
      const h = (host ?? "").toLowerCase().trim();
      if (!h) return true;
      return platformRedirectHosts.has(h);
    },

    cloudflareConfigured: !!(s.cloudflareApiToken && s.cloudflareZoneId),
    cloudflareRegistrarConfigured: !!(s.cloudflareApiToken && s.cloudflareAccountId),
    localByodEnabled: !!(s.platformIpv4 && s.byodCnameTarget),
    champvaultConfigured: !!(s.champvaultUrl && s.champvaultApiKey),
    maxmindWsConfigured: !!(s.maxmindAccountId && s.maxmindLicenseKey),
    companyIntelConfigured: (() => {
      const p = (s.companyIntelProvider || "none").toLowerCase();
      if (p === "asn") return true;
      if (p === "ipinfo") return !!s.ipinfoApiToken;
      return false;
    })(),
    clerkEnvironment: s.clerkSecretKey.startsWith("sk_live_") ? "production" : "development",
    clerkWebhookConfigured: !!s.clerkWebhookSecret,
    resolvedClerkIssuer: resolveClerkIssuer(s.clerkIssuer, s.clerkPublishableKey),
    clerkAuthorizedPartiesList: (() => {
      const raw = s.clerkAuthorizedParties.trim();
      let parties: string[];
      if (raw) parties = splitCsv(raw).map((p) => p.replace(/\/+$/, ""));
      else {
        parties = s.frontendUrl ? [s.frontendUrl.replace(/\/+$/, "")] : [];
        parties.push(...splitCsv(s.corsAllowOrigins).map((o) => o.replace(/\/+$/, "")));
      }
      return [...new Set(parties.filter(Boolean))];
    })(),
    /** R2 presigned URLs available (all S3 credentials set). */
    r2PresignConfigured: !!(s.r2AccountId && s.r2AccessKeyId && s.r2SecretAccessKey && s.r2BucketName),
    /** Storage is always configured on Cloudflare (the R2 binding). */
    storageConfigured: true,
    resolvedUploadSecret: s.storageUploadSecret || s.clerkSecretKey,
  };
}

function resolveClerkIssuer(explicit: string, publishableKey: string): string {
  if (explicit) return explicit.replace(/\/+$/, "");
  const pk = publishableKey.trim();
  if (!pk) return "";
  try {
    const parts = pk.split("_");
    const body = parts.slice(2).join("_") || parts[parts.length - 1];
    const b64 = body.replace(/-/g, "+").replace(/_/g, "/");
    const host = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4))
      .replace(/\$+$/, "")
      .replace(/^\/+|\/+$/g, "");
    // A real publishable key decodes to a Frontend API hostname; anything else
    // (a placeholder like pk_test_xxx) must not produce a bogus issuer.
    return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host) ? `https://${host}` : "";
  } catch {
    return "";
  }
}

export type Settings = ReturnType<typeof buildSettings>;

const cache = new WeakMap<object, Settings>();

/** Settings for this env (memoized per env object, i.e. per isolate). */
export function getSettings(env: Env): Settings {
  let s = cache.get(env);
  if (!s) {
    s = buildSettings(env);
    cache.set(env, s);
  }
  return s;
}
