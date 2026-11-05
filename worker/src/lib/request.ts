/**
 * Request facts that the Python code read off Starlette's Request.
 *
 * On Cloudflare the real visitor IP is CF-Connecting-IP (set by the edge, not
 * spoofable by the client), and geo/ASN come free on `request.cf` — this
 * replaces the MaxMind .mmdb lookups for the common case.
 */
import type { Context } from "hono";

/** Visitor IP: CF-Connecting-IP, else first X-Forwarded-For hop, else X-Real-IP. */
export function clientIp(c: Context): string | null {
  const h = c.req.raw.headers;
  const cf = h.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const fwd = h.get("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = h.get("x-real-ip");
  return real ? real.trim() : null;
}

/** Host the client used, lowercased, without port (FastAPI: request.headers["host"]). */
export function requestHost(c: Context): string {
  const raw = c.req.raw.headers.get("host") ?? new URL(c.req.url).host;
  return raw.toLowerCase().replace(/:\d+$/, "").trim();
}

/** Scheme + host the client used, e.g. "https://share.lakeb2b.com" (request.base_url). */
export function requestOrigin(c: Context): string {
  const url = new URL(c.req.url);
  const proto = c.req.raw.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  return `${proto}://${c.req.raw.headers.get("host") ?? url.host}`;
}

export interface CfGeo {
  country: string | null;
  countryCode: string | null;
  region: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
  asn: number | null;
  asOrganization: string | null;
}

const regionNames = (() => {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" });
  } catch {
    return null;
  }
})();

/** Geo/ASN facts Cloudflare attached to this request (all null off-edge, e.g. in tests). */
export function cfGeo(c: Context): CfGeo {
  const cf = (c.req.raw as Request & { cf?: IncomingRequestCfProperties }).cf;
  const code = (cf?.country as string | undefined) ?? null;
  const usable = code && code !== "XX" && code !== "T1" ? code : null;
  const num = (v: unknown) => (v == null || v === "" ? null : Number(v));
  return {
    countryCode: usable,
    country: usable ? (regionNames?.of(usable) ?? usable) : null,
    region: (cf?.region as string | undefined) || null,
    city: (cf?.city as string | undefined) || null,
    latitude: num(cf?.latitude),
    longitude: num(cf?.longitude),
    asn: num(cf?.asn),
    asOrganization: (cf?.asOrganization as string | undefined) || null,
  };
}

export function getCookie(c: Context, name: string): string | null {
  const header = c.req.raw.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}
