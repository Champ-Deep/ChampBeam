/**
 * Helpers shared by routes/utm.ts and routes/_utmAnalytics.ts (the helper
 * section of backend/app/api/v1/utm.py plus Python-compat formatting).
 */
import type { Ctx } from "../env";
import { httpError } from "../lib/errors";
import { requestOrigin } from "../lib/request";

/** Canonical lowercase hyphenated UUID, or null when `v` is not a UUID (`_to_uuid`). */
export function normUuid(v: string | null | undefined): string | null {
  if (!v) return null;
  const m = /^\{?(?:urn:uuid:)?([0-9a-f]{8})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{12})\}?$/i.exec(v.trim());
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}-${m[4]}-${m[5]}`.toLowerCase();
}

interface IsoParts {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
  ms: number;
  offsetMin: number | null;
}

/** datetime.fromisoformat (common forms). Returns null where Python raises ValueError. */
export function pyFromIsoformat(v: string): IsoParts | null {
  const m =
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2})(?::(\d{2})(?::(\d{2})(?:[.,](\d{1,6}))?)?)?(Z|[+-]\d{2}(?::?\d{2})?)?)?$/i.exec(
      v.trim(),
    );
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const h = Number(m[4] ?? 0);
  const mi = Number(m[5] ?? 0);
  const s = Number(m[6] ?? 0);
  const ms = m[7] ? Math.floor(Number(m[7].padEnd(6, "0")) / 1000) : 0;
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59) return null;
  const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (d > dim) return null;
  let offsetMin: number | null = null;
  const tz = m[8];
  if (tz) {
    if (tz.toUpperCase() === "Z") offsetMin = 0;
    else {
      const sign = tz[0] === "-" ? -1 : 1;
      const digits = tz.slice(1).replace(":", "");
      offsetMin = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4) || 0));
    }
  }
  return { y, mo, d, h, mi, s, ms, offsetMin };
}

function partsToIso(p: IsoParts, applyOffset: boolean): string {
  const t = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s, p.ms);
  const shifted = applyOffset && p.offsetMin ? t - p.offsetMin * 60_000 : t;
  const d = new Date(shifted);
  // Date.UTC maps years 0-99 to 19xx; fix up so text comparison stays sane.
  if (p.y < 100) d.setUTCFullYear(p.y);
  return d.toISOString();
}

/**
 * `_resolve_date_range`: explicit start/end dates (end extended to 23:59:59)
 * or `days` back from now. Returned as stored-format ISO strings so they
 * compare correctly against the text timestamp columns.
 */
export function resolveDateRange(days: number, startDate?: string | null, endDate?: string | null): [string, string] {
  const now = Date.now();
  if (startDate && endDate) {
    const s = pyFromIsoformat(startDate);
    const e = pyFromIsoformat(endDate);
    if (!s || !e) httpError(400, "Invalid date format. Use ISO 8601 (YYYY-MM-DD).");
    const end = { ...e!, h: 23, mi: 59, s: 59 };
    const start = partsToIso(s!, true);
    const endIso = partsToIso(end, true);
    if (start > endIso) httpError(400, "start_date must be before end_date.");
    return [start, endIso];
  }
  return [new Date(now - days * 86_400_000).toISOString(), new Date(now).toISOString()];
}

/** `since` for /analytics/clicks/recent: Python drops the tz offset without converting. */
export function naiveIso(v: string): string | null {
  const p = pyFromIsoformat(v);
  return p ? partsToIso(p, false) : null;
}

/** Python's round(x, 2) for floats (exact-value, ties to even). */
export function pyRound2(x: number): number {
  if (!Number.isFinite(x)) return x;
  const [ip, fp] = Math.abs(x).toFixed(20).split(".");
  let n = BigInt(ip + fp.slice(0, 2));
  const rest = fp.slice(2);
  const half = "5".padEnd(rest.length, "0");
  if (rest > half || (rest === half && n % 2n === 1n)) n += 1n;
  return (x < 0 ? -1 : 1) * (Number(n) / 100);
}

/** str(float) as Python's csv module writes it ("50.0", not "50"). */
export function pyFloatStr(x: number): string {
  return Number.isInteger(x) ? x.toFixed(1) : String(x);
}

/** unique / links * 100, rounded like Python. */
export function clickRate(unique: number, links: number): number {
  return pyRound2(links > 0 ? (unique / links) * 100 : 0);
}

/**
 * `_build_redirect_url`: custom domain (HTTPS) -> REDIRECT_BASE_URL -> the
 * host the client used.
 */
export function buildRedirectUrl(c: Ctx, shortCode: string | null | undefined, domainHost?: string | null): string | null {
  if (!shortCode) return null;
  if (domainHost) return `https://${domainHost}/r/${shortCode}`;
  const override = (c.var.settings.redirectBaseUrl || "").replace(/\/+$/, "");
  const base = override || requestOrigin(c);
  return `${base}/r/${shortCode}`;
}

/** Text/CSV attachment (Starlette appends the utf-8 charset to text/* types). */
export function csvResponse(body: string, filename: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename=${filename}`,
    },
  });
}

export const num = (v: unknown): number => (v == null ? 0 : Number(v));

/**
 * `_get_user_link`: the caller's link or 404 "Link not found". (Python 500'd
 * on a malformed id when the UUID cast failed; here that is a plain 404.)
 */
export async function getUserLink(c: Ctx, linkId: string, userId: string): Promise<Record<string, unknown>> {
  const id = normUuid(linkId);
  const row = id
    ? await c.env.DB.prepare("SELECT * FROM link_clicks WHERE id = ? AND user_id = ?").bind(id, userId).first()
    : null;
  if (!row) httpError(404, "Link not found");
  return row!;
}

/** link domain_id -> hostname for a batch of link rows (`_domains_by_link`). */
export async function domainHosts(c: Ctx, domainIds: (string | null | undefined)[]): Promise<Map<string, string>> {
  const ids = [...new Set(domainIds.filter((d): d is string => !!d))];
  const out = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 90) {
    const part = ids.slice(i, i + 90);
    const res = await c.env.DB.prepare(`SELECT id, hostname FROM domains WHERE id IN (${part.map(() => "?").join(",")})`)
      .bind(...part)
      .all<{ id: string; hostname: string }>();
    for (const r of res.results) out.set(r.id, r.hostname);
  }
  return out;
}
