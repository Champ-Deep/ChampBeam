/**
 * Company intent — reverse-IP firmographic enrichment (provider-agnostic).
 * Port of backend/app/services/company_intel.py.
 *
 * Providers (COMPANY_INTEL_PROVIDER):
 * - `none`   : disabled.
 * - `asn`    : $0. No external call — analytics reuse the ASN/network owner we
 *              already resolve (click_events.asn_org). resolveCompany returns
 *              null (nothing to store); the aggregation falls back to asn_org.
 * - `ipinfo` : IPinfo's IP-to-Company add-on. Real company name/domain/type when
 *              the token's plan includes the company dataset.
 * - `http`   : any IP-to-company vendor API, by config only. COMPANY_INTEL_URL is
 *              a template with `{ip}` (and optionally `{key}`); COMPANY_INTEL_API_KEY
 *              goes in the URL when `{key}` is present, else as a Bearer token.
 *
 * Every provider returns the same normalized shape (or null):
 *   { name, domain, industry, size, type }
 * All lookups are best-effort: any error or miss returns null.
 *
 * Paid providers (ipinfo, http) reuse a company already resolved for the same IP
 * in the last 30 days when `db` is passed, so a returning visitor costs one lookup.
 *
 * Exports:
 *   interface CompanyInfo { name: string; domain; industry; size; type: string | null }
 *   resolveCompany(deps: { settings: Settings; fetch?: typeof fetch; db?: Db }, ip: string | null | undefined,
 *                  opts?: { timeoutMs?: number }): Promise<CompanyInfo | null>
 *   toCompany(payload: unknown): CompanyInfo | null
 */
import { and, desc, eq, gte, isNotNull } from "drizzle-orm";
import type { Db } from "../db/client";
import { clickEvents } from "../db/schema";
import type { Settings } from "../env";

export interface CompanyInfo {
  name: string;
  domain: string | null;
  industry: string | null;
  size: string | null;
  type: string | null;
}

export interface CompanyDeps {
  settings: Settings;
  fetch?: typeof fetch;
  db?: Db;
}

const CACHE_DAYS = 30;

function norm(value: unknown): string | null {
  if (value == null || typeof value === "object") return null;
  const s = String(value).trim();
  return s || null;
}

/**
 * Map a vendor payload to CompanyInfo. Reads the `company` object (IPinfo,
 * Snitcher and Clearbit Reveal all nest it there) or, failing that, top-level
 * fields. A bare ASN `org` string never counts as a company.
 * shortcut: covers the common field names only; add aliases when a vendor's real payload is in hand.
 */
export function toCompany(payload: unknown): CompanyInfo | null {
  const data = payload as any;
  const c = data?.company && typeof data.company === "object" && !Array.isArray(data.company) ? data.company : data;
  const name = norm(c?.name);
  if (!name) return null;
  const domain = norm(c.domain ?? c.website)?.toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").split("/")[0] || null;
  return {
    name,
    domain,
    industry: norm(c.industry ?? c.category?.industry ?? c.sector),
    size: norm(c.size ?? c.employees_range ?? c.employee_range ?? c.metrics?.employeesRange),
    type: norm(c.type), // business|isp|hosting|education|…
  };
}

/** Resolve an IP to firmographic company data, or null (none/asn providers, miss, error). */
export async function resolveCompany(
  deps: CompanyDeps,
  ip: string | null | undefined,
  { timeoutMs = 5000 }: { timeoutMs?: number } = {},
): Promise<CompanyInfo | null> {
  if (!ip) return null;
  const s = deps.settings;
  const provider = (s.companyIntelProvider || "none").toLowerCase();
  let url: string, headers: Record<string, string> = { Accept: "application/json" };
  if (provider === "ipinfo") {
    if (!s.ipinfoApiToken) return null;
    url = `https://ipinfo.io/${encodeURIComponent(ip)}/json?token=${encodeURIComponent(s.ipinfoApiToken)}`;
  } else if (provider === "http") {
    if (!s.companyIntelUrl) return null;
    url = s.companyIntelUrl.replace("{ip}", encodeURIComponent(ip)).replace("{key}", encodeURIComponent(s.companyIntelApiKey));
    if (s.companyIntelApiKey && !s.companyIntelUrl.includes("{key}")) headers = { ...headers, Authorization: `Bearer ${s.companyIntelApiKey}` };
  } else {
    // "none" and "asn" store nothing (asn reuses the existing asn_org column).
    return null;
  }

  const cached = deps.db ? await cachedCompany(deps.db, ip) : null;
  if (cached) return cached;

  try {
    const f = deps.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    const resp = await f(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (resp.status >= 400) {
      console.warn(`${provider} company lookup ${ip} -> ${resp.status}`);
      return null;
    }
    return toCompany(await resp.json());
  } catch (err) {
    console.warn(`${provider} company lookup failed for ${ip}`, err);
    return null;
  }
}

/** Latest company already resolved for this IP within CACHE_DAYS, or null. Never throws. */
async function cachedCompany(db: Db, ip: string): Promise<CompanyInfo | null> {
  try {
    const cutoff = new Date(Date.now() - CACHE_DAYS * 86_400_000).toISOString();
    const row = await db
      .select({
        name: clickEvents.companyName,
        domain: clickEvents.companyDomain,
        industry: clickEvents.companyIndustry,
        size: clickEvents.companySize,
        type: clickEvents.companyType,
      })
      .from(clickEvents)
      .where(and(eq(clickEvents.ipAddress, ip), isNotNull(clickEvents.companyName), gte(clickEvents.clickedAt, cutoff)))
      .orderBy(desc(clickEvents.clickedAt))
      .limit(1)
      .get();
    return row?.name ? (row as CompanyInfo) : null;
  } catch (err) {
    console.warn("company cache read failed", err);
    return null;
  }
}
