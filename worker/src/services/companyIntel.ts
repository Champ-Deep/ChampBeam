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
 *
 * Every provider returns the same normalized shape (or null):
 *   { name, domain, industry, size, type }
 * All lookups are best-effort: any error or miss returns null.
 *
 * Exports:
 *   interface CompanyInfo { name: string; domain; industry; size; type: string | null }
 *   resolveCompany(deps: { settings: Settings; fetch?: typeof fetch }, ip: string | null | undefined,
 *                  opts?: { timeoutMs?: number }): Promise<CompanyInfo | null>
 */
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
}

function norm(value: unknown): string | null {
  if (value == null) return null;
  const s = String(value).trim();
  return s || null;
}

/** Resolve an IP to firmographic company data, or null (none/asn providers, miss, error). */
export async function resolveCompany(
  deps: CompanyDeps,
  ip: string | null | undefined,
  { timeoutMs = 5000 }: { timeoutMs?: number } = {},
): Promise<CompanyInfo | null> {
  if (!ip) return null;
  const provider = (deps.settings.companyIntelProvider || "none").toLowerCase();
  if (provider === "ipinfo") return ipinfo(deps, ip, timeoutMs);
  // "none" and "asn" store nothing (asn reuses the existing asn_org column).
  return null;
}

async function ipinfo(deps: CompanyDeps, ip: string, timeoutMs: number): Promise<CompanyInfo | null> {
  const token = deps.settings.ipinfoApiToken;
  if (!token) return null;
  let data: any;
  try {
    const f = deps.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    const resp = await f(`https://ipinfo.io/${encodeURIComponent(ip)}/json?token=${encodeURIComponent(token)}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (resp.status >= 400) {
      console.warn(`ipinfo lookup ${ip} -> ${resp.status}`);
      return null;
    }
    data = await resp.json();
  } catch (err) {
    console.warn(`ipinfo lookup failed for ${ip}`, err);
    return null;
  }

  // The firmographic payload lives under `company` on plans that include the
  // IP-to-Company dataset. Only a real company object counts — the bare `org`
  // (ASN) is the free "network" signal handled by the asn provider.
  const company = data?.company;
  if (!company || typeof company !== "object" || Array.isArray(company)) return null;
  const name = norm(company.name);
  if (!name) return null;
  return {
    name,
    domain: norm(company.domain),
    industry: norm(company.industry),
    size: norm(company.size),
    type: norm(company.type), // business|isp|hosting|education|…
  };
}
