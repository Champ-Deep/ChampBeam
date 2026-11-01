/**
 * UTM service — port of backend/app/services/utm_service.py.
 *
 * URL generation, bulk CSV processing, link recording, click/view recording
 * and background geo/company enrichment of click events.
 *
 * D1 notes: there are no interactive transactions, so writes that Python
 * committed together go through `db.batch([...])`, and every counter is an
 * atomic SQL increment (`click_count = COALESCE(click_count, 0) + 1`) instead of
 * a read-modify-write on a loaded row.
 *
 * Exports (Python name -> TS):
 *   UTM_KEYS
 *   generateUtmUrl(baseUrl: string, utmParams: UtmParams, preserveExisting = true): string
 *   generateShortCode(): string                                    (_generate_short_code, 7 alnum chars)
 *   recordLink(db: Db, args: { userId, originalUrl, trackedUrl, utmParams, projectName?, projectId?, domainId? }): Promise<LinkClick>
 *   recordClickEvent(db: Db, link: LinkClick, args: { ipAddress, userAgent, referrer, domainId? }): Promise<ClickEvent>
 *   bumpClickCounter(db: Db, linkId: string, ipAddress: string | null): Promise<void>
 *   consumeLinkView(db: Db, linkId: string, ipAddress: string | null): Promise<"ok"|"revoked"|"expired"|"maxed"|"gone">
 *   insertClickEvent(db: Db, args: { linkId, ipAddress, userAgent, referrer, domainId? }): Promise<string>   (event id)
 *   recordFileViewEvent(db: Db, file: FileAsset, args: { ipAddress, userAgent, referrer, domainId?, visitorId?, isRevisit?, fileUpdates? }): Promise<ClickEvent>
 *   lastFileViewAt(db: Db, fileId: string, visitorId: string): Promise<string | null>
 *   resolveGeoForEvent(deps: GeoDeps & { db: Db }, eventId: string, ipAddress: string | null, opts?: { cf?: CfGeo | null }): Promise<void>
 *   captureVisit(c: Context): VisitContext                         ({ ip, userAgent, referrer, cf } read during the request)
 *   scheduleGeoEnrichment(c: Ctx, eventId: string, visit?: VisitContext): void   (background(resolveGeoForEvent) with request.cf captured)
 *   processBulkCsv(csvContent: string, defaultParams?: UtmParams, opts?: { db, userId, projectId, shortLinkBuilder }): Promise<string>
 *   injectUtmIntoHtml(html: string, utmParams: UtmParams, preserveExisting = true): [string, InjectedLinkMeta[]]
 *   incrementLinkClick(db: Db, linkClickId: string): Promise<void>
 *   types: UtmParams, LinkClick, ClickEvent, FileAsset, VisitContext, InjectedLinkMeta
 *   CSV helpers (Python csv-module compatible): parseCsv(text): string[][], toCsvRow(fields): string
 */
import { and, eq, isNull, max, or, sql, lt, gt } from "drizzle-orm";
import type { Context } from "hono";
import type { Db } from "../db/client";
import { isUniqueViolation } from "../db/client";
import { clickEvents, fileAssets, linkClicks } from "../db/schema";
import type { Ctx } from "../env";
import { background } from "../lib/background";
import { randomString } from "../lib/crypto";
import { cfGeo, clientIp as coreClientIp, type CfGeo } from "../lib/request";
import { nowIso } from "../lib/time";
import { resolveCompany } from "./companyIntel";
import { type GeoDeps, lookupIp } from "./geoip";
import { type NotifyDeps, notifyOpen } from "./openWebhook";
import { parseUserAgent } from "./ua";

export const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"] as const;

export type UtmParams = Record<string, string | null | undefined>;
export type LinkClick = typeof linkClicks.$inferSelect;
export type ClickEvent = typeof clickEvents.$inferSelect;
export type FileAsset = typeof fileAssets.$inferSelect;

// ---------------------------------------------------------------------------
// urllib.parse equivalents (urlsplit / urlunsplit / parse_qs / urlencode)
// ---------------------------------------------------------------------------
const SCHEME_CHARS = /^[A-Za-z][A-Za-z0-9+\-.]*$/;
const USES_NETLOC = new Set([
  "", "ftp", "http", "gopher", "nntp", "telnet", "imap", "wais", "file", "mms", "https", "shttp",
  "snews", "prospero", "rtsp", "rtsps", "rtspu", "rsync", "svn", "svn+ssh", "sftp", "nfs", "git",
  "git+ssh", "ws", "wss", "itms-services",
]);

interface SplitUrl {
  scheme: string;
  netloc: string;
  path: string;
  query: string;
  fragment: string;
}

function urlsplit(input: string): SplitUrl {
  // urllib strips leading C0 control chars/space and removes tab/CR/LF.
  let url = input.replace(/^[\x00-\x20]+/, "").replace(/[\t\r\n]/g, "");
  let scheme = "";
  let netloc = "";
  let query = "";
  let fragment = "";
  const i = url.indexOf(":");
  if (i > 0 && SCHEME_CHARS.test(url.slice(0, i))) {
    scheme = url.slice(0, i).toLowerCase();
    url = url.slice(i + 1);
  }
  if (url.startsWith("//")) {
    let end = url.length;
    for (const ch of "/?#") {
      const p = url.indexOf(ch, 2);
      if (p >= 0) end = Math.min(end, p);
    }
    netloc = url.slice(2, end);
    url = url.slice(end);
    if (netloc.includes("[") !== netloc.includes("]")) throw new Error("Invalid IPv6 URL");
  }
  const h = url.indexOf("#");
  if (h >= 0) {
    fragment = url.slice(h + 1);
    url = url.slice(0, h);
  }
  const q = url.indexOf("?");
  if (q >= 0) {
    query = url.slice(q + 1);
    url = url.slice(0, q);
  }
  return { scheme, netloc, path: url, query, fragment };
}

function urlunsplit({ scheme, netloc, path, query, fragment }: SplitUrl): string {
  let url = path;
  if (netloc || (scheme && USES_NETLOC.has(scheme) && !url.startsWith("//"))) {
    if (url && !url.startsWith("/")) url = "/" + url;
    url = "//" + netloc + url;
  }
  if (scheme) url = scheme + ":" + url;
  if (query) url += "?" + query;
  if (fragment) url += "#" + fragment;
  return url;
}

/** urllib.parse.unquote_plus (UTF-8, errors="replace"). */
function unquotePlus(s: string): string {
  s = s.replace(/\+/g, " ");
  if (!s.includes("%")) return s;
  const bytes: number[] = [];
  const enc = new TextEncoder();
  for (let i = 0; i < s.length; ) {
    if (s[i] === "%" && /^[0-9a-fA-F]{2}$/.test(s.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(s.slice(i + 1, i + 3), 16));
      i += 3;
    } else {
      const cp = s.codePointAt(i)!;
      const ch = String.fromCodePoint(cp);
      bytes.push(...enc.encode(ch));
      i += ch.length;
    }
  }
  return new TextDecoder("utf-8").decode(new Uint8Array(bytes));
}

/** urllib.parse.quote_plus (safe: letters, digits, "_.-~"). */
function quotePlus(s: string): string {
  return encodeURIComponent(s)
    .replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/%20/g, "+");
}

/** parse_qs(query, keep_blank_values=...) -> ordered map of key -> values. */
function parseQs(query: string, keepBlank: boolean): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of query.split("&")) {
    if (!part) continue;
    const eqIdx = part.indexOf("=");
    let k: string;
    let v: string;
    if (eqIdx < 0) {
      if (!keepBlank) continue;
      k = part;
      v = "";
    } else {
      k = part.slice(0, eqIdx);
      v = part.slice(eqIdx + 1);
    }
    if (!v && !keepBlank) continue;
    const key = unquotePlus(k);
    const val = unquotePlus(v);
    const list = out.get(key);
    if (list) list.push(val);
    else out.set(key, [val]);
  }
  return out;
}

/** urlencode(map, doseq=True) */
function urlencode(qs: Map<string, string[]>): string {
  const parts: string[] = [];
  for (const [k, vals] of qs) for (const v of vals) parts.push(`${quotePlus(k)}=${quotePlus(v)}`);
  return parts.join("&");
}

// ---------------------------------------------------------------------------
// Generate a single UTM URL
// ---------------------------------------------------------------------------
/**
 * Build a URL with UTM parameters appended. With `preserveExisting`, params
 * already present in the URL are not overwritten. Adds https:// when there is
 * no scheme, strips trailing "?"/"#", collapses duplicate slashes in the path.
 */
export function generateUtmUrl(baseUrl: string, utmParams: UtmParams, preserveExisting = true): string {
  // Strip trailing hashes and question marks if user inputs them accidentally
  baseUrl = baseUrl.trim();
  while (baseUrl.endsWith("?") || baseUrl.endsWith("#")) baseUrl = baseUrl.slice(0, -1);

  let parsed = urlsplit(baseUrl);
  if (!parsed.scheme) {
    baseUrl = "https://" + baseUrl;
    parsed = urlsplit(baseUrl);
  }

  // Collapse repeated slashes in the path only (never the scheme's "//").
  const cleanedPath = parsed.path.replace(/\/\/+/g, "/");

  const existing = parseQs(parsed.query, true);
  for (const [key, raw] of Object.entries(utmParams)) {
    if (!raw) continue;
    const value = String(raw).trim();
    if (!value) continue;
    if (preserveExisting && existing.has(key)) continue;
    existing.set(key, [value]);
  }

  return urlunsplit({ ...parsed, path: cleanedPath, query: urlencode(existing) });
}

// ---------------------------------------------------------------------------
// Short codes / link records
// ---------------------------------------------------------------------------
const ALPHANUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

export function generateShortCode(): string {
  return randomString(7, ALPHANUM);
}

/**
 * Record a generated link for click tracking (deduplicated: an identical link
 * for the same user/UTM set/domain is reused, re-pointed at `projectId` when
 * one is given).
 */
export async function recordLink(
  db: Db,
  args: {
    userId: string;
    originalUrl: string;
    trackedUrl: string;
    utmParams: UtmParams;
    projectName?: string | null;
    projectId?: string | null;
    domainId?: string | null;
    /** Org the link is shared under (reporting). Part of the dedup key: no silent reassignment. */
    organizationId?: string | null;
    /** External contact this link is minted for. Part of the dedup key: one link per contact. */
    contactRef?: string | null;
  },
): Promise<LinkClick> {
  const { userId, originalUrl, trackedUrl, utmParams } = args;
  const contactRef = args.contactRef ?? null;
  const organizationId = args.organizationId ?? null;
  const projectId = args.projectId ?? null;
  const domainId = args.domainId ?? null;
  const src = utmParams.utm_source ?? null;
  const med = utmParams.utm_medium ?? null;
  const cam = utmParams.utm_campaign ?? null;
  const con = utmParams.utm_content ?? null;
  const trm = utmParams.utm_term ?? null;

  const existing = await db
    .select()
    .from(linkClicks)
    .where(
      and(
        eq(linkClicks.userId, userId),
        eq(linkClicks.originalUrl, originalUrl),
        src ? eq(linkClicks.utmSource, src) : isNull(linkClicks.utmSource),
        med ? eq(linkClicks.utmMedium, med) : isNull(linkClicks.utmMedium),
        cam ? eq(linkClicks.utmCampaign, cam) : isNull(linkClicks.utmCampaign),
        con ? eq(linkClicks.utmContent, con) : isNull(linkClicks.utmContent),
        trm ? eq(linkClicks.utmTerm, trm) : isNull(linkClicks.utmTerm),
        domainId ? eq(linkClicks.domainId, domainId) : isNull(linkClicks.domainId),
        organizationId ? eq(linkClicks.organizationId, organizationId) : isNull(linkClicks.organizationId),
        contactRef ? eq(linkClicks.contactRef, contactRef) : isNull(linkClicks.contactRef),
      ),
    )
    .limit(1)
    .get();
  if (existing) {
    if (projectId && existing.projectId !== projectId) {
      await db.update(linkClicks).set({ projectId }).where(eq(linkClicks.id, existing.id)).run();
      existing.projectId = projectId;
    }
    return existing;
  }

  // 62^7 codes; retry on the (unlikely) unique-index collision.
  for (let attempt = 0; ; attempt++) {
    const row = {
      id: crypto.randomUUID(),
      userId,
      shortCode: generateShortCode(),
      projectId,
      projectName: args.projectName ?? null,
      domainId,
      organizationId,
      contactRef,
      originalUrl,
      trackedUrl,
      utmSource: src,
      utmMedium: med,
      utmCampaign: cam,
      utmContent: con,
      utmTerm: trm,
      clickCount: 0,
      uniqueClicks: 0,
      createdAt: nowIso(),
    };
    try {
      return (await db.insert(linkClicks).values(row).returning().get()) as LinkClick;
    } catch (err) {
      if (attempt < 4 && isUniqueViolation(err)) continue;
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Click / view recording
// ---------------------------------------------------------------------------
async function hasPriorClick(db: Db, linkId: string, ipAddress: string | null | undefined): Promise<boolean> {
  if (!ipAddress) return false;
  const row = await db
    .select({ id: clickEvents.id })
    .from(clickEvents)
    .where(and(eq(clickEvents.linkId, linkId), eq(clickEvents.ipAddress, ipAddress)))
    .limit(1)
    .get();
  return !!row;
}

/** Best-effort uniqueness: when the click_events check fails, count as unique. */
async function isUniqueClick(db: Db, linkId: string, ipAddress: string | null | undefined): Promise<boolean> {
  try {
    return !(await hasPriorClick(db, linkId, ipAddress));
  } catch (err) {
    console.error(`unique check failed for link_id=${linkId}; treating click as unique`, err);
    return true;
  }
}

function counterSet(isUnique: boolean, now: string) {
  return {
    clickCount: sql`COALESCE(${linkClicks.clickCount}, 0) + 1`,
    uniqueClicks: sql`COALESCE(${linkClicks.uniqueClicks}, 0) + ${isUnique ? 1 : 0}`,
    lastClickedAt: now,
    firstClickedAt: sql`COALESCE(${linkClicks.firstClickedAt}, ${now})`,
  };
}

/**
 * Record an individual click event with parsed UA info and bump the link's
 * counters (one atomic batch). GeoIP is resolved separately in the background
 * (see scheduleGeoEnrichment). The passed `link` object's counters are updated
 * in place to reflect the write.
 */
export async function recordClickEvent(
  db: Db,
  link: LinkClick,
  args: { ipAddress: string | null; userAgent: string | null; referrer: string | null; domainId?: string | null },
): Promise<ClickEvent> {
  const ua = parseUserAgent(args.userAgent ?? "");
  const isUnique = !(await hasPriorClick(db, link.id, args.ipAddress));
  const now = nowIso();
  const event = {
    id: crypto.randomUUID(),
    linkId: link.id,
    fileId: null,
    domainId: args.domainId != null ? args.domainId : link.domainId,
    visitorId: null,
    isRevisit: false,
    ipAddress: args.ipAddress,
    userAgent: args.userAgent,
    referrer: args.referrer,
    deviceType: ua.device_type,
    browser: ua.browser,
    os: ua.os,
    clickedAt: now,
  };
  const [inserted] = await db.batch([
    db.insert(clickEvents).values(event).returning(),
    db.update(linkClicks).set(counterSet(isUnique, now)).where(eq(linkClicks.id, link.id)),
  ]);
  link.clickCount = (link.clickCount ?? 0) + 1;
  link.lastClickedAt = now;
  if (link.firstClickedAt == null) link.firstClickedAt = now;
  if (isUnique) link.uniqueClicks = (link.uniqueClicks ?? 0) + 1;
  return inserted[0] as ClickEvent;
}

/**
 * Atomically increment click counters on a LinkClick with a single UPDATE that
 * only touches link_clicks, so the increment lands even if click_events is
 * unhealthy. Uniqueness is best-effort (counted unique if the check fails).
 */
export async function bumpClickCounter(db: Db, linkId: string, ipAddress: string | null): Promise<void> {
  const isUnique = await isUniqueClick(db, linkId, ipAddress);
  await db.update(linkClicks).set(counterSet(isUnique, nowIso())).where(eq(linkClicks.id, linkId)).run();
}

export type LinkViewStatus = "ok" | "revoked" | "expired" | "maxed" | "gone";

/**
 * Atomic self-destruct gate + view counter for a link at redirect time.
 * Returns "ok" when the view is allowed (and counted), else the block reason.
 * The gate lives in the UPDATE's WHERE, so the view cap is race-safe:
 * click_count never exceeds max_views.
 */
export async function consumeLinkView(db: Db, linkId: string, ipAddress: string | null): Promise<LinkViewStatus> {
  const now = nowIso();
  const isUnique = await isUniqueClick(db, linkId, ipAddress);
  const updated = await db
    .update(linkClicks)
    .set(counterSet(isUnique, now))
    .where(
      and(
        eq(linkClicks.id, linkId),
        isNull(linkClicks.revokedAt),
        or(isNull(linkClicks.expiresAt), gt(linkClicks.expiresAt, now)),
        or(isNull(linkClicks.maxViews), lt(sql`COALESCE(${linkClicks.clickCount}, 0)`, linkClicks.maxViews)),
      ),
    )
    .returning({ id: linkClicks.id })
    .all();
  if (updated.length > 0) return "ok";

  // Blocked — classify for the expired-page message.
  const link = await db
    .select({ revokedAt: linkClicks.revokedAt, expiresAt: linkClicks.expiresAt })
    .from(linkClicks)
    .where(eq(linkClicks.id, linkId))
    .get();
  if (!link) return "gone";
  if (link.revokedAt != null) return "revoked";
  if (link.expiresAt != null && link.expiresAt <= now) return "expired";
  return "maxed";
}

const clip = (v: string | null | undefined, n: number): string | null => (v == null ? null : v.slice(0, n));

/**
 * Insert a ClickEvent row on its own (counters live in consumeLinkView /
 * bumpClickCounter so this can fail independently). Returns the event id;
 * throws on failure (callers log and carry on, as in Python).
 */
export async function insertClickEvent(
  db: Db,
  args: {
    linkId: string;
    ipAddress: string | null;
    userAgent: string | null;
    referrer: string | null;
    domainId?: string | null;
  },
): Promise<string> {
  const ua = parseUserAgent(args.userAgent ?? "");
  const id = crypto.randomUUID();
  // Clamp to the Postgres column lengths so data stays migratable both ways.
  await db
    .insert(clickEvents)
    .values({
      id,
      linkId: args.linkId,
      domainId: args.domainId ?? null,
      ipAddress: clip(args.ipAddress, 45),
      userAgent: args.userAgent,
      referrer: args.referrer,
      deviceType: clip(ua.device_type, 50),
      browser: clip(ua.browser, 100),
      os: clip(ua.os, 100),
      isRevisit: false,
      clickedAt: nowIso(),
    })
    .run();
  return id;
}

/**
 * Record a view against a FileAsset (mirrors recordClickEvent): inserts the
 * event and bumps view_count/last_viewed_at in one batch. `fileUpdates` are
 * extra file columns persisted in the same write (Python flushed any pending
 * changes on the asset here, e.g. a lazily-minted state_token).
 */
export async function recordFileViewEvent(
  db: Db,
  file: FileAsset,
  args: {
    ipAddress: string | null;
    userAgent: string | null;
    referrer: string | null;
    domainId?: string | null;
    visitorId?: string | null;
    isRevisit?: boolean;
    fileUpdates?: Partial<typeof fileAssets.$inferInsert>;
  },
): Promise<ClickEvent> {
  const ua = parseUserAgent(args.userAgent ?? "");
  const now = nowIso();
  const event = {
    id: crypto.randomUUID(),
    linkId: null,
    fileId: file.id,
    domainId: args.domainId != null ? args.domainId : file.domainId,
    ipAddress: args.ipAddress,
    userAgent: args.userAgent,
    referrer: args.referrer,
    deviceType: ua.device_type,
    browser: ua.browser,
    os: ua.os,
    visitorId: args.visitorId ?? null,
    isRevisit: !!args.isRevisit,
    clickedAt: now,
  };
  const [inserted] = await db.batch([
    db.insert(clickEvents).values(event).returning(),
    db
      .update(fileAssets)
      .set({
        ...(args.fileUpdates ?? {}),
        viewCount: sql`COALESCE(${fileAssets.viewCount}, 0) + 1`,
        lastViewedAt: now,
      })
      .where(eq(fileAssets.id, file.id)),
  ]);
  file.viewCount = (file.viewCount ?? 0) + 1;
  file.lastViewedAt = now;
  if (args.fileUpdates) Object.assign(file, args.fileUpdates);
  return inserted[0] as ClickEvent;
}

/** Most recent view of `fileId` by `visitorId` (for revisit detection), or null. */
export async function lastFileViewAt(db: Db, fileId: string, visitorId: string): Promise<string | null> {
  const row = await db
    .select({ last: max(clickEvents.clickedAt) })
    .from(clickEvents)
    .where(and(eq(clickEvents.fileId, fileId), eq(clickEvents.visitorId, visitorId)))
    .get();
  return row?.last ?? null;
}

// ---------------------------------------------------------------------------
// Background enrichment
// ---------------------------------------------------------------------------
/**
 * Resolve GeoIP + VPN/ASN + company intent, then update the click event. Geo and
 * company enrichment are independent — either can land on its own. Pass the
 * `cf` geo captured during the request (request.cf is gone by the time a
 * waitUntil task runs).
 */
export async function resolveGeoForEvent(
  deps: NotifyDeps,
  eventId: string,
  ipAddress: string | null,
  opts: { cf?: CfGeo | null } = {},
): Promise<void> {
  if (!ipAddress) return;
  const geo = await lookupIp(deps, ipAddress, { cf: opts.cf });
  const company = await resolveCompany(deps, ipAddress);
  if (geo || company) await storeEnrichment(deps, eventId, geo, company);
  await notifyOpen(deps, eventId);
}

async function storeEnrichment(
  deps: GeoDeps & { db: Db },
  eventId: string,
  geo: Awaited<ReturnType<typeof lookupIp>>,
  company: Awaited<ReturnType<typeof resolveCompany>>,
): Promise<void> {
  const set: Partial<typeof clickEvents.$inferInsert> = {};
  if (geo) {
    Object.assign(set, {
      country: geo.country,
      countryCode: geo.country_code,
      region: geo.region,
      city: geo.city,
      latitude: geo.latitude,
      longitude: geo.longitude,
      isVpn: geo.is_vpn != null ? !!geo.is_vpn : false,
      asnOrg: geo.asn_org,
    });
  }
  if (company) {
    Object.assign(set, {
      companyName: company.name,
      companyDomain: company.domain,
      companyIndustry: company.industry,
      companySize: company.size,
      companyType: company.type,
    });
  }
  // The event row is inserted (and awaited) before the response, so it is
  // always visible here — no retry loop needed as in the Python.
  const res = await deps.db.update(clickEvents).set(set).where(eq(clickEvents.id, eventId)).returning({ id: clickEvents.id }).all();
  if (res.length === 0) console.warn(`resolveGeoForEvent: event ${eventId} not found, dropping geo enrichment`);
}

/** Visitor facts to capture during the request (needed after the response). */
export interface VisitContext {
  ip: string | null;
  userAgent: string | null;
  referrer: string | null;
  cf: CfGeo;
}

/**
 * Snapshot the visitor's IP, UA, referrer and request.cf geo. Uses the core
 * clientIp (CF-Connecting-IP first); pass your own `ip` when the route resolved
 * it differently (e.g. accessControl.clientIp).
 */
export function captureVisit(c: Context, ip?: string | null): VisitContext {
  return {
    ip: ip !== undefined ? ip : coreClientIp(c),
    userAgent: c.req.header("user-agent") ?? null,
    referrer: c.req.header("referer") ?? null,
    cf: cfGeo(c),
  };
}

/**
 * `background_tasks.add_task(utm_service.resolve_geo_for_event, event_id, ip)`
 * for the Worker: schedules enrichment via waitUntil with the request's cf geo
 * captured now. No-op without an IP (same as the Python callers).
 */
export function scheduleGeoEnrichment(c: Ctx, eventId: string, visit: VisitContext = captureVisit(c)): void {
  if (!visit.ip) return;
  const deps = { settings: c.var.settings, db: c.var.db, openWebhook: c.env.OPEN_WEBHOOK };
  background(c, () => resolveGeoForEvent(deps, eventId, visit.ip, { cf: visit.cf }), "resolveGeoForEvent");
}

// ---------------------------------------------------------------------------
// CSV (Python csv module compatible: QUOTE_MINIMAL, "\r\n" line terminator)
// ---------------------------------------------------------------------------
/** Parse CSV text into rows (csv.reader semantics); blank lines are dropped. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let hasContent = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"' && field === "") {
      inQuotes = true;
      hasContent = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
      hasContent = true;
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      if (hasContent) {
        row.push(field);
        rows.push(row);
      }
      row = [];
      field = "";
      hasContent = false;
    } else {
      field += ch;
      hasContent = true;
    }
  }
  if (hasContent) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function quoteField(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** One CSV record terminated by "\r\n" (csv.writer QUOTE_MINIMAL). */
export function toCsvRow(fields: (string | null | undefined)[]): string {
  const vals = fields.map((f) => f ?? "");
  // Python quotes a lone empty field so the record isn't mistaken for a blank line.
  if (vals.length === 1 && vals[0] === "") return '""\r\n';
  return vals.map(quoteField).join(",") + "\r\n";
}

// ---------------------------------------------------------------------------
// Bulk CSV processing
// ---------------------------------------------------------------------------
/**
 * Process a CSV of URLs and append UTM parameters. The input must have a `url`
 * column and may carry utm_* columns overriding `defaultParams` per row.
 * With `db` + `userId`, every row is persisted via recordLink so each URL gets
 * a trackable short code; `shortLinkBuilder(code)` fills the `short_link`
 * column. Returns CSV with `tracked_url`, `short_link`, `error` appended.
 * Throws Error("CSV must contain a 'url' column") (Python ValueError).
 */
export async function processBulkCsv(
  csvContent: string,
  defaultParams: UtmParams | null = null,
  opts: {
    db?: Db | null;
    userId?: string | null;
    projectId?: string | null;
    shortLinkBuilder?: ((shortCode: string) => string | null | undefined) | null;
  } = {},
): Promise<string> {
  const defaults = defaultParams ?? {};
  const track = !!opts.userId && !!opts.db;

  const records = parseCsv(csvContent);
  const fieldnames = records[0];
  if (!fieldnames || !fieldnames.includes("url")) throw new Error("CSV must contain a 'url' column");

  const outputFields = [...fieldnames, "tracked_url", "short_link", "error"];
  let out = toCsvRow(outputFields);

  for (const rec of records.slice(1)) {
    const row: Record<string, string> = {};
    fieldnames.forEach((name, i) => {
      row[name] = rec[i] ?? "";
    });
    const write = () => {
      out += toCsvRow(outputFields.map((f) => row[f] ?? ""));
    };

    const baseUrl = (row.url ?? "").trim();
    row.error = "";
    row.tracked_url = "";
    row.short_link = "";

    if (!baseUrl) {
      row.error = "Missing URL";
      write();
      continue;
    }
    if (!baseUrl.includes(".") && !baseUrl.includes("localhost") && !baseUrl.startsWith("http")) {
      row.error = "Invalid URL format";
      write();
      continue;
    }

    const params: UtmParams = { ...defaults };
    for (const key of UTM_KEYS) {
      const v = (row[key] ?? "").trim();
      if (v) params[key] = v;
    }

    let tracked: string;
    try {
      tracked = generateUtmUrl(baseUrl, params);
      row.tracked_url = tracked;
    } catch (e) {
      row.error = `Failed to generate: ${(e as Error).message}`;
      write();
      continue;
    }

    if (track) {
      try {
        const link = await recordLink(opts.db!, {
          userId: opts.userId!,
          originalUrl: baseUrl.startsWith("http") ? baseUrl : `https://${baseUrl}`,
          trackedUrl: tracked,
          utmParams: params,
          projectId: opts.projectId ?? null,
        });
        if (link.shortCode && opts.shortLinkBuilder) row.short_link = opts.shortLinkBuilder(link.shortCode) || "";
      } catch (e) {
        console.error(`bulk: failed to persist trackable link for ${baseUrl}`, e);
        row.error = `Tracking failed: ${(e as Error).message}`;
      }
    }
    write();
  }
  return out;
}

// ---------------------------------------------------------------------------
// Inject UTM params into HTML links
// ---------------------------------------------------------------------------
export interface InjectedLinkMeta {
  original_url: string;
  tracked_url: string;
  anchor_text: string | null;
  position: number;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
}

/**
 * Inject UTM parameters into all trackable <a href> links in HTML. With
 * `preserveExisting`, links already carrying utm_* params are left alone.
 * Returns [modifiedHtml, linksMetadata].
 */
export function injectUtmIntoHtml(
  htmlBody: string,
  utmParams: UtmParams,
  preserveExisting = true,
): [string, InjectedLinkMeta[]] {
  const links: InjectedLinkMeta[] = [];
  let position = 0;
  const linkPattern = /(<a\s[^>]*href=["'])([^"']+)(["'][^>]*>)(.*?)(<\/a>)/gis;
  const stripTags = (t: string) => t.replace(/<[^>]+>/g, "").trim();

  const modified = htmlBody.replace(linkPattern, (whole, prefix: string, url: string, mid: string, inner: string, suffix: string) => {
    const lower = url.toLowerCase();
    if (["mailto:", "tel:", "javascript:"].some((s) => lower.startsWith(s))) return whole;

    if (preserveExisting) {
      let query = "";
      try {
        query = urlsplit(url).query;
      } catch {
        query = "";
      }
      if ([...parseQs(query, false).keys()].some((k) => k.startsWith("utm_"))) return whole;
    }

    const newUrl = generateUtmUrl(url, utmParams, false);
    const anchor = stripTags(inner);
    const meta: InjectedLinkMeta = {
      original_url: url,
      tracked_url: newUrl,
      anchor_text: anchor ? anchor.slice(0, 500) : null,
      position: position++,
      utm_source: utmParams.utm_source ?? null,
      utm_medium: utmParams.utm_medium ?? null,
      utm_campaign: utmParams.utm_campaign ?? null,
      utm_content: utmParams.utm_content ?? null,
      utm_term: utmParams.utm_term ?? null,
    };
    links.push(meta);
    return `${prefix}${newUrl}${mid}${inner}${suffix}`;
  });
  return [modified, links];
}

// ---------------------------------------------------------------------------
// Increment link click
// ---------------------------------------------------------------------------
/** Increment click counts for a tracked link (unique bumps only on the very first click). */
export async function incrementLinkClick(db: Db, linkClickId: string): Promise<void> {
  const now = nowIso();
  const res = await db
    .update(linkClicks)
    .set({
      uniqueClicks: sql`COALESCE(${linkClicks.uniqueClicks}, 0) + CASE WHEN ${linkClicks.clickCount} = 0 THEN 1 ELSE 0 END`,
      clickCount: sql`COALESCE(${linkClicks.clickCount}, 0) + 1`,
      lastClickedAt: now,
      firstClickedAt: sql`COALESCE(${linkClicks.firstClickedAt}, ${now})`,
    })
    .where(eq(linkClicks.id, linkClickId))
    .returning({ id: linkClicks.id })
    .all();
  if (res.length) console.info(`Link click incremented: id=${linkClickId}`);
  else console.warn(`LinkClick not found: id=${linkClickId}`);
}
