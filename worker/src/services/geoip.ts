/**
 * GeoIP lookup — port of backend/app/services/geoip_service.py.
 *
 * Provider chain on Cloudflare (each step optional, each fails open — geo must
 * never break click tracking):
 *   1. `request.cf` (country/region/city/lat/lon/ASN org) — free, on every
 *      request; replaces the local MaxMind GeoLite2 City + ASN .mmdb files.
 *      VPN/hosting is inferred from the ASN owner, exactly as the Python did
 *      with the local ASN database.
 *      When the MaxMind web service is configured with the "insights" endpoint
 *      it is still called so its anonymizer traits (VPN / proxy / Tor /
 *      hosting / residential proxy) decide `is_vpn`; request.cf fills any gaps.
 *   2. MaxMind GeoIP2 web service (HTTPS) — when no request.cf data is available.
 *   3. IPinfo (HTTPS) — next fallback.
 *   (ip-api.com, the Python last resort, is dropped: plain HTTP and it blocks
 *   datacenter egress IPs such as Cloudflare's.)
 *
 * request.cf is only reachable while handling the request, so callers capture
 * `cfGeo(c)` up front and pass it in (also into background enrichment).
 *
 * Exports:
 *   interface GeoResult { country, country_code, region, city, latitude, longitude, is_vpn, asn_org }
 *   interface GeoDeps   { settings: Settings; db?: Db | null; fetch?: typeof fetch }
 *   HOSTING_KEYWORDS: Set<string>
 *   isHostingAsn(asnOrg: string | null | undefined): boolean              (_is_hosting_asn)
 *   isPrivateIp(ip: string): boolean                                       (_is_private_ip)
 *   geoFromCf(cf: CfGeo | null | undefined): GeoResult | null              (replaces _lookup_city + _lookup_asn)
 *   lookupMaxmindWs(deps: GeoDeps, ip: string): Promise<GeoResult | null>  (_lookup_maxmind_ws)
 *   lookupIpinfo(deps: GeoDeps, ip: string): Promise<GeoResult | null>     (_lookup_ipinfo)
 *   recordWsUsage(deps: GeoDeps, queriesRemaining: number | null, ok: boolean): Promise<void>  (never throws)
 *   lookupIp(deps: GeoDeps, ip: string | null | undefined, opts?: { cf?: CfGeo | null }): Promise<GeoResult | null>
 */
import type { Db } from "../db/client";
import type { Settings } from "../env";
import type { CfGeo } from "../lib/request";
import { recordLookup } from "./maxmindUsage";

export interface GeoResult {
  country: string | null;
  country_code: string | null;
  region: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
  is_vpn: boolean | null;
  asn_org: string | null;
}

export interface GeoDeps {
  settings: Settings;
  /** Used to book MaxMind web-service usage; skipped when absent. */
  db?: Db | null;
  /** Injectable for tests; defaults to globalThis.fetch. */
  fetch?: typeof fetch;
}

const PROVIDER_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------------------
// ASN-based VPN/hosting detection
// ---------------------------------------------------------------------------
export const HOSTING_KEYWORDS = new Set([
  // Major cloud providers
  "amazon", "aws", "google cloud", "microsoft", "azure",
  "digitalocean", "linode", "akamai", "vultr", "ovh",
  "hetzner", "cloudflare", "oracle", "alibaba cloud",
  "rackspace", "ibm cloud", "scaleway", "upcloud",
  // VPN providers
  "nordvpn", "expressvpn", "surfshark", "cyberghost",
  "private internet access", "mullvad", "protonvpn", "proton ag",
  "ipvanish", "tunnelbear", "windscribe", "hotspot shield",
  // Hosting companies
  "hostgator", "godaddy", "bluehost", "namecheap",
  "choopa", "m247", "datacamp", "psychz", "cogent",
  "quadranet", "leaseweb", "zscaler", "fortinet",
  // Generic hosting indicators
  "hosting", "datacenter", "data center", "colocation",
  "server", "cloud", "vps",
]);

/** True when an ASN organization name matches known hosting/VPN providers. */
export function isHostingAsn(asnOrg: string | null | undefined): boolean {
  if (!asnOrg) return false;
  const org = asnOrg.toLowerCase();
  for (const k of HOSTING_KEYWORDS) if (org.includes(k)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Private IP detection (same prefixes as the Python)
// ---------------------------------------------------------------------------
const PRIVATE_IPS = new Set(["127.0.0.1", "::1", "0.0.0.0"]);
const PRIVATE_PREFIXES = ["10.", "192.168.", ...Array.from({ length: 16 }, (_, i) => `172.${16 + i}.`)];

export function isPrivateIp(ip: string): boolean {
  if (PRIVATE_IPS.has(ip)) return true;
  return PRIVATE_PREFIXES.some((p) => ip.startsWith(p));
}

// ---------------------------------------------------------------------------
// request.cf (replaces the local GeoLite2 City + ASN readers)
// ---------------------------------------------------------------------------
/** Normalize Cloudflare's request.cf geo into a GeoResult; null when it carries nothing. */
export function geoFromCf(cf: CfGeo | null | undefined): GeoResult | null {
  if (!cf) return null;
  const hasGeo = !!(cf.countryCode || cf.city || cf.region || cf.latitude != null);
  if (!hasGeo && !cf.asOrganization) return null;
  return {
    country: cf.country,
    country_code: cf.countryCode,
    region: cf.region,
    city: cf.city,
    latitude: cf.latitude,
    longitude: cf.longitude,
    is_vpn: cf.asOrganization ? isHostingAsn(cf.asOrganization) : null,
    asn_org: cf.asOrganization,
  };
}

const doFetch = (deps: GeoDeps): typeof fetch => deps.fetch ?? ((...a) => fetch(...a));

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// ---------------------------------------------------------------------------
// IPinfo (HTTPS, works from datacenters)
// ---------------------------------------------------------------------------
/**
 * Geo + ISP/VPN via IPinfo (reuses IPINFO_API_TOKEN from company intent).
 * Returns null when no token is set or the call fails. Country is the ISO code
 * (IPinfo doesn't return a full name on the base response).
 */
export async function lookupIpinfo(deps: GeoDeps, ip: string): Promise<GeoResult | null> {
  const token = deps.settings.ipinfoApiToken;
  if (!token) return null;
  let data: Record<string, any>;
  try {
    const resp = await doFetch(deps)(
      `https://ipinfo.io/${encodeURIComponent(ip)}/json?token=${encodeURIComponent(token)}`,
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) },
    );
    if (resp.status >= 400) return null;
    data = (await resp.json()) as Record<string, any>;
  } catch (err) {
    console.debug(`ipinfo lookup failed for ${ip}`, err);
    return null;
  }
  if (!data || typeof data !== "object" || data.bogon) return null;

  const loc = String(data.loc ?? "").split(",");
  const lat = loc.length === 2 && loc[0] ? num(loc[0]) : null;
  const lng = loc.length === 2 && loc[1] ? num(loc[1]) : null;

  const org = str(data.org);
  const asnOrg = org ? org.replace(/^AS\d+\s+/, "").trim() : null;

  const privacy = data.privacy && typeof data.privacy === "object" ? data.privacy : {};
  const isVpn =
    Object.keys(privacy).length > 0
      ? !!(privacy.vpn || privacy.proxy || privacy.tor || privacy.hosting)
      : // No privacy dataset on this plan — infer from the ASN owner.
        isHostingAsn(asnOrg);

  const cc = str(data.country);
  return {
    country: cc, // ISO code; request.cf supplies full names when merged
    country_code: cc,
    region: str(data.region),
    city: str(data.city),
    latitude: lat,
    longitude: lng,
    is_vpn: isVpn,
    asn_org: asnOrg,
  };
}

// ---------------------------------------------------------------------------
// MaxMind GeoIP2 web service (GeoIP Insights / City / Country) — HTTPS
// ---------------------------------------------------------------------------
/** Book one web-service call. Never throws (telemetry must never break geo). */
export async function recordWsUsage(deps: GeoDeps, queriesRemaining: number | null, ok: boolean): Promise<void> {
  try {
    if (!deps.db) return;
    await recordLookup(deps.db, { queriesRemaining, ok });
  } catch {
    // ignore
  }
}

const englishName = (o: any): string | null => str(o?.names?.en);

/**
 * Geo + ISP/VPN via the MaxMind GeoIP2 web service (REST: /geoip/v2.1/{endpoint}/{ip}).
 * The Insights endpoint returns anonymizer traits for VPN detection; the City
 * and Country endpoints carry none, so VPN is inferred from the ASN owner.
 * Returns null when unconfigured or on any error.
 */
export async function lookupMaxmindWs(deps: GeoDeps, ip: string): Promise<GeoResult | null> {
  const s = deps.settings;
  if (!s.maxmindWsConfigured) return null;
  const rawId = String(s.maxmindAccountId).trim();
  if (!/^[+-]?\d+$/.test(rawId)) return null;
  const accountId = String(Number.parseInt(rawId, 10));

  const ep = (s.maxmindWsEndpoint || "insights").toLowerCase();
  const endpoint = ep === "country" ? "country" : ep === "city" ? "city" : "insights";
  const host = s.maxmindWsHost || "geoip.maxmind.com";

  let body: Record<string, any>;
  try {
    const resp = await doFetch(deps)(`https://${host}/geoip/v2.1/${endpoint}/${encodeURIComponent(ip)}`, {
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${btoa(`${accountId}:${s.maxmindLicenseKey}`)}`,
      },
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    if (!resp.ok) throw new Error(`MaxMind web service HTTP ${resp.status}`);
    body = (await resp.json()) as Record<string, any>;
  } catch (err) {
    // AddressNotFound / auth / quota / network -> fail open
    console.debug(`MaxMind web service lookup failed for ${ip}`, err);
    await recordWsUsage(deps, null, false);
    return null;
  }

  // MaxMind returns its own remaining-credit counter on every response, so the
  // balance is observed for free — no billing API call, no extra query spent.
  await recordWsUsage(deps, num(body?.maxmind?.queries_remaining), true);

  const country = body.country ?? null;
  const subs = Array.isArray(body.subdivisions) ? body.subdivisions : [];
  const region = subs.length ? englishName(subs[subs.length - 1]) : null;
  const location = body.location ?? null;
  const traits = body.traits ?? {};

  const asnOrg = str(traits.isp) ?? str(traits.autonomous_system_organization) ?? str(traits.organization);

  const isVpn =
    endpoint === "insights"
      ? !!(
          traits.is_anonymous_vpn ||
          traits.is_public_proxy ||
          traits.is_tor_exit_node ||
          traits.is_hosting_provider ||
          traits.is_residential_proxy ||
          traits.is_anonymous
        )
      : // City/Country endpoints carry no anonymizer flags — infer from the owner.
        isHostingAsn(asnOrg);

  return {
    country: englishName(country) ?? str(country?.iso_code),
    country_code: str(country?.iso_code),
    region,
    city: englishName(body.city),
    latitude: num(location?.latitude),
    longitude: num(location?.longitude),
    is_vpn: isVpn,
    asn_org: asnOrg,
  };
}

/** Provider values win; request.cf fills whatever the provider left empty. */
function mergeOver(primary: GeoResult, fallback: GeoResult): GeoResult {
  const out = { ...primary };
  for (const k of Object.keys(out) as (keyof GeoResult)[]) {
    if (out[k] == null) (out as any)[k] = fallback[k];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
/**
 * Geographic info for an IP: { country, country_code, region, city, latitude,
 * longitude, is_vpn, asn_org }, or null when nothing resolves or the IP is
 * private/empty. Pass `cf: cfGeo(c)` captured from the visitor's request.
 */
export async function lookupIp(
  deps: GeoDeps,
  ip: string | null | undefined,
  opts: { cf?: CfGeo | null } = {},
): Promise<GeoResult | null> {
  if (!ip || isPrivateIp(ip)) return null;

  const fromCf = geoFromCf(opts.cf);
  if (fromCf) {
    // Anonymizer traits from GeoIP Insights beat the ASN-name heuristic.
    let wsTried = false;
    if (deps.settings.maxmindWsConfigured && (deps.settings.maxmindWsEndpoint || "insights").toLowerCase() === "insights") {
      wsTried = true;
      const ws = await lookupMaxmindWs(deps, ip);
      if (ws) return mergeOver(ws, fromCf);
    }
    if (fromCf.asn_org) return fromCf;
    // No ASN on request.cf — top up ISP/VPN from a web service (Python's
    // "City DB without ASN DB" branch).
    const vpn = (wsTried ? null : await lookupMaxmindWs(deps, ip)) ?? (await lookupIpinfo(deps, ip));
    fromCf.asn_org = vpn?.asn_org ?? null;
    fromCf.is_vpn = vpn ? vpn.is_vpn : null;
    return fromCf;
  }

  // No request.cf data (off-edge / unknown IP): datacenter-safe web services.
  return (await lookupMaxmindWs(deps, ip)) ?? (await lookupIpinfo(deps, ip));
}
