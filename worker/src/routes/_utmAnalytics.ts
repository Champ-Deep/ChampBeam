/**
 * /api/v1/utm/analytics/* — the analytics half of backend/app/api/v1/utm.py,
 * registered on the utm router by registerAnalytics().
 *
 * SQL translation notes (Postgres -> SQLite/D1):
 *  - timestamps are ISO text, so date_trunc('day', col) is substr(col, 1, 10)
 *    and the Python `date.isoformat()` of that bucket is "YYYY-MM-DDT00:00:00";
 *    func.date(col) (str(date)) is plain "YYYY-MM-DD".
 *  - "the caller's links/files" is a subquery / join on user_id, never a bound
 *    IN list, so the 100-parameter limit cannot bite.
 *  - `col == _to_uuid(bad)` compared against NULL in SQLAlchemy (IS NULL), so
 *    project filters use `project_id IS ?` with the normalized id or null.
 */
import type { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Ctx } from "../env";
import { requireAuth } from "../auth/security";
import { httpError } from "../lib/errors";
import { isoUtc, parseIso } from "../lib/time";
import { parseQuery, qStr } from "../lib/validate";
import { toCsvRow } from "../services/utm";
import {
  buildRedirectUrl,
  clickRate,
  csvResponse,
  domainHosts,
  getUserLink,
  naiveIso,
  normUuid,
  num,
  pyFloatStr,
} from "./_utmHelpers";
import { resolveDateRange } from "./_utmHelpers";

type Row = Record<string, unknown>;
type Param = string | number | null;

async function all<T = Row>(c: Ctx, sqlText: string, params: Param[]): Promise<T[]> {
  const res = await c.env.DB.prepare(sqlText).bind(...params).all<T>();
  return res.results ?? [];
}

async function first<T = Row>(c: Ctx, sqlText: string, params: Param[]): Promise<T> {
  return (await c.env.DB.prepare(sqlText).bind(...params).first<T>()) as T;
}

/** Query(default, ge, le) int (typed non-optional, unlike lib qInt's union). */
const qInt = (def: number, opts: { ge: number; le: number }) => z.coerce.number().int().min(opts.ge).max(opts.le).default(def);
const qDef = (def: string) => z.string().default(def);

const rangeQuery = (days: number) => ({
  days: qInt(days, { ge: 1, le: 365 }),
  start_date: qStr(),
  end_date: qStr(),
});

/** day bucket as Python's date_trunc('day').isoformat() rendered it. */
const truncDay = (col: string) => `substr(${col}, 1, 10) || 'T00:00:00'`;

/** WHERE builder: (clause, params) pairs joined with AND. */
class Where {
  parts: string[] = [];
  params: Param[] = [];
  add(clause: string, ...params: Param[]): this {
    this.parts.push(clause);
    this.params.push(...params);
    return this;
  }
  get sql(): string {
    return this.parts.length ? this.parts.join(" AND ") : "1=1";
  }
}

const linkJson = (c: Ctx, hosts: Map<string, string>) => (l: Row) => ({
  link_id: l.id as string,
  original_url: l.original_url as string,
  tracked_url: (l.tracked_url as string | null) ?? null,
  redirect_url: buildRedirectUrl(c, l.short_code as string | null, hosts.get(l.domain_id as string)),
  short_code: (l.short_code as string | null) ?? null,
});

function geoRows(level: string, rows: Row[]) {
  if (level === "region") {
    return rows.map((r) => ({ country: r.country, country_code: r.country_code, region: r.region, clicks: num(r.clicks) }));
  }
  if (level === "city") {
    return rows.map((r) => ({
      country: r.country,
      country_code: r.country_code,
      region: r.region,
      city: r.city,
      clicks: num(r.clicks),
    }));
  }
  return rows.map((r) => ({ country: r.country, country_code: r.country_code, clicks: num(r.clicks) }));
}

function geoCols(level: string): string {
  if (level === "region") return "ce.country, ce.country_code, ce.region";
  if (level === "city") return "ce.country, ce.country_code, ce.region, ce.city";
  return "ce.country, ce.country_code";
}

/** Geo breakdown of click_events joined to link_clicks (`ce`/`lc`) under `w`. */
async function geoBreakdown(c: Ctx, level: string, w: Where, limit?: number) {
  const cols = geoCols(level);
  const rows = await all(
    c,
    `SELECT ${cols}, COUNT(ce.id) AS clicks FROM click_events ce JOIN link_clicks lc ON ce.link_id = lc.id
     WHERE ${w.sql} GROUP BY ${cols} ORDER BY COUNT(ce.id) DESC${limit ? ` LIMIT ${limit}` : ""}`,
    w.params,
  );
  return geoRows(level, rows);
}

async function countBy(c: Ctx, col: string, w: Where, from: string, limit?: number): Promise<Row[]> {
  return all(
    c,
    `SELECT ${col} AS k, COUNT(ce.id) AS clicks FROM ${from} WHERE ${w.sql} GROUP BY ${col} ORDER BY COUNT(ce.id) DESC${
      limit ? ` LIMIT ${limit}` : ""
    }`,
    w.params,
  );
}

const CE_JOIN_LC = "click_events ce JOIN link_clicks lc ON ce.link_id = lc.id";

// Obvious consumer ISPs / clouds / hosting to drop from the free "asn" fallback,
// where we only have the network owner (not a real business-vs-isp classifier).
// With a firmographic provider this is unnecessary — company_type does the job.
const NETWORK_NOISE = [
  "comcast", "verizon", "at&t", "att ", "spectrum", "charter", "cox ", "centurylink",
  "t-mobile", "sprint", "vodafone", "telstra", "orange", "telefonica", "deutsche telekom",
  "jio", "airtel", "bsnl", "sky ", "virgin media", "bell canada", "rogers", "shaw ",
  "amazon", "aws", "google", "microsoft", "azure", "cloudflare", "digitalocean", "ovh",
  "hetzner", "linode", "akamai", "fastly", "oracle cloud", "gcp",
];

function looksLikeNetworkNoise(name: string | null | undefined): boolean {
  if (!name) return true;
  const low = name.toLowerCase();
  return NETWORK_NOISE.some((k) => low.includes(k));
}

function intentTemperature(recencyDays: number, opens: number): "hot" | "warm" | "cool" {
  if (recencyDays <= 3 && opens >= 3) return "hot";
  if (recencyDays <= 10 || opens >= 3) return "warm";
  return "cool";
}
const TEMP_RANK = { hot: 0, warm: 1, cool: 2 } as const;

/** "Caller owns this event" — the event's link or file belongs to the user. */
const OWNED_EVENT = `(ce.link_id IN (SELECT id FROM link_clicks WHERE user_id = ?)
  OR ce.file_id IN (SELECT id FROM file_assets WHERE user_id = ?))`;

export function registerAnalytics(router: Hono<AppEnv>): void {
  // ==========================================================================
  // Overview / breakdown / links / performance
  // ==========================================================================

  router.get("/analytics/overview", async (c) => {
    const user = await requireAuth(c);
    const q = parseQuery(c, z.object({ project_id: qStr() }));
    const w = new Where().add("user_id = ?", user.userId);
    if (q.project_id) w.add("project_id IS ?", normUuid(q.project_id));

    const agg = await first<Row>(
      c,
      `SELECT COUNT(id) AS total_links, COALESCE(SUM(click_count), 0) AS total_clicks,
              COALESCE(SUM(unique_clicks), 0) AS unique_clicks FROM link_clicks WHERE ${w.sql}`,
      w.params,
    );
    const totalLinks = num(agg?.total_links);
    const uniqueClicks = num(agg?.unique_clicks);

    const top = (col: string) =>
      all(
        c,
        `SELECT ${col} AS k, COALESCE(SUM(click_count), 0) AS total_clicks FROM link_clicks
         WHERE ${w.sql} AND ${col} IS NOT NULL GROUP BY ${col} ORDER BY SUM(click_count) DESC LIMIT 5`,
        w.params,
      );
    const [sources, campaigns] = await Promise.all([top("utm_source"), top("utm_campaign")]);

    return c.json({
      total_tracked_links: totalLinks,
      total_clicks: num(agg?.total_clicks),
      unique_clicks: uniqueClicks,
      overall_click_rate: clickRate(uniqueClicks, totalLinks),
      top_sources: sources.map((r) => ({ source: r.k, clicks: num(r.total_clicks) })),
      top_campaigns: campaigns.map((r) => ({ campaign: r.k, clicks: num(r.total_clicks) })),
    });
  });

  router.get("/analytics/breakdown", async (c) => {
    const user = await requireAuth(c);
    const q = parseQuery(
      c,
      z.object({ group_by: qDef("source"), project_name: qStr(), project_id: qStr(), ...rangeQuery(30) }),
    );
    const columnMap: Record<string, string> = {
      source: "utm_source",
      medium: "utm_medium",
      campaign: "utm_campaign",
      content: "utm_content",
      term: "utm_term",
    };
    const column = Object.hasOwn(columnMap, q.group_by) ? columnMap[q.group_by] : undefined;
    if (!column) {
      httpError(400, `Invalid group_by '${q.group_by}'. Must be: source, medium, campaign, content, term`);
    }
    const [start, end] = resolveDateRange(q.days, q.start_date, q.end_date);
    const w = new Where()
      .add("user_id = ?", user.userId)
      .add("created_at >= ?", start)
      .add("created_at <= ?", end)
      .add(`${column} IS NOT NULL`);
    if (q.project_id) w.add("project_id IS ?", normUuid(q.project_id));
    else if (q.project_name) w.add("project_name = ?", q.project_name);

    const rows = await all(
      c,
      `SELECT ${column} AS group_value, COUNT(id) AS total_links, COALESCE(SUM(click_count), 0) AS total_clicks,
              COALESCE(SUM(unique_clicks), 0) AS unique_clicks
       FROM link_clicks WHERE ${w.sql} GROUP BY ${column} ORDER BY SUM(click_count) DESC`,
      w.params,
    );
    return c.json(
      rows.map((r) => ({
        group_key: q.group_by,
        group_value: r.group_value,
        total_links: num(r.total_links),
        total_clicks: num(r.total_clicks),
        unique_clicks: num(r.unique_clicks),
        click_rate: clickRate(num(r.unique_clicks), num(r.total_links)),
      })),
    );
  });

  router.get("/analytics/links", async (c) => {
    const user = await requireAuth(c);
    const q = parseQuery(c, z.object({ project_name: qStr(), project_id: qStr(), ...rangeQuery(30) }));
    const [start, end] = resolveDateRange(q.days, q.start_date, q.end_date);
    const w = new Where().add("user_id = ?", user.userId).add("created_at >= ?", start).add("created_at <= ?", end);
    if (q.project_id) w.add("project_id IS ?", normUuid(q.project_id));
    else if (q.project_name) w.add("project_name = ?", q.project_name);

    const links = await all(
      c,
      `SELECT * FROM link_clicks WHERE ${w.sql} ORDER BY click_count DESC, created_at DESC LIMIT 200`,
      w.params,
    );
    const hosts = await domainHosts(c, links.map((l) => l.domain_id as string | null));
    const base = linkJson(c, hosts);
    return c.json(
      links.map((l) => ({
        ...base(l),
        anchor_text: l.anchor_text ?? null,
        utm_source: l.utm_source ?? null,
        utm_medium: l.utm_medium ?? null,
        utm_campaign: l.utm_campaign ?? null,
        utm_content: l.utm_content ?? null,
        utm_term: l.utm_term ?? null,
        project_name: l.project_name ?? null,
        project_id: l.project_id ?? null,
        click_count: num(l.click_count),
        unique_clicks: num(l.unique_clicks),
        first_clicked_at: isoUtc(l.first_clicked_at as string | null),
        created_at: isoUtc(l.created_at as string | null),
      })),
    );
  });

  router.get("/analytics/performance", async (c) => {
    const user = await requireAuth(c);
    const q = parseQuery(c, z.object({ project_name: qStr(), project_id: qStr(), ...rangeQuery(30) }));
    const [start, end] = resolveDateRange(q.days, q.start_date, q.end_date);
    const w = new Where().add("user_id = ?", user.userId).add("created_at >= ?", start).add("created_at <= ?", end);
    if (q.project_id) w.add("project_id IS ?", normUuid(q.project_id));
    else if (q.project_name) w.add("project_name = ?", q.project_name);

    const bucket = truncDay("created_at");
    const rows = await all(
      c,
      `SELECT ${bucket} AS date, COUNT(id) AS links_created, COALESCE(SUM(click_count), 0) AS total_clicks,
              COALESCE(SUM(unique_clicks), 0) AS unique_clicks
       FROM link_clicks WHERE ${w.sql} GROUP BY ${bucket} ORDER BY ${bucket}`,
      w.params,
    );
    return c.json({
      days: q.days,
      data: rows.map((r) => ({
        date: r.date ?? null,
        links_created: num(r.links_created),
        total_clicks: num(r.total_clicks),
        unique_clicks: num(r.unique_clicks),
      })),
    });
  });

  // ==========================================================================
  // Per-link analytics
  // ==========================================================================

  /** Events of one (owned) link inside the requested range. */
  async function linkScope(c: Ctx) {
    const user = await requireAuth(c);
    const q = parseQuery(c, z.object({ level: qDef("country"), ...rangeQuery(30) }));
    const link = await getUserLink(c, c.req.param("link_id")!, user.userId);
    const [start, end] = resolveDateRange(q.days, q.start_date, q.end_date);
    const w = new Where()
      .add("ce.link_id = ?", link.id as string)
      .add("ce.clicked_at >= ?", start)
      .add("ce.clicked_at <= ?", end);
    return { q, w };
  }

  router.get("/analytics/links/:link_id/events", async (c) => {
    const { w } = await linkScope(c);
    const rows = await all(
      c,
      `SELECT * FROM click_events ce WHERE ${w.sql} ORDER BY ce.clicked_at DESC LIMIT 500`,
      w.params,
    );
    return c.json(
      rows.map((e) => ({
        id: e.id,
        ip_address: e.ip_address ?? null,
        device_type: e.device_type ?? null,
        browser: e.browser ?? null,
        os: e.os ?? null,
        country: e.country ?? null,
        country_code: e.country_code ?? null,
        region: e.region ?? null,
        city: e.city ?? null,
        referrer: e.referrer ?? null,
        is_vpn: !!e.is_vpn,
        asn_org: e.asn_org ?? null,
        clicked_at: isoUtc(e.clicked_at as string),
      })),
    );
  });

  router.get("/analytics/links/:link_id/geo", async (c) => {
    const { q, w } = await linkScope(c);
    const cols = geoCols(q.level);
    const rows = await all(
      c,
      `SELECT ${cols}, COUNT(ce.id) AS clicks FROM click_events ce WHERE ${w.sql}
       GROUP BY ${cols} ORDER BY COUNT(ce.id) DESC`,
      w.params,
    );
    return c.json(geoRows(q.level, rows));
  });

  router.get("/analytics/links/:link_id/devices", async (c) => {
    const { w } = await linkScope(c);
    const [devices, browsers] = await Promise.all([
      countBy(c, "ce.device_type", w, "click_events ce"),
      countBy(c, "ce.browser", w, "click_events ce"),
    ]);
    return c.json({
      devices: devices.map((r) => ({ device_type: r.k, clicks: num(r.clicks) })),
      browsers: browsers.map((r) => ({ browser: r.k, clicks: num(r.clicks) })),
    });
  });

  // ==========================================================================
  // Company intent (reverse-IP) — which companies open the caller's content
  // ==========================================================================

  router.get("/analytics/company-intent", async (c) => {
    const user = await requireAuth(c);
    const q = parseQuery(c, z.object({ days: qInt(14, { ge: 1, le: 365 }), limit: qInt(25, { ge: 1, le: 200 }) }));
    const provider = c.var.settings.companyIntelProvider;
    const now = Date.now();
    const cutoff = new Date(now - q.days * 86_400_000).toISOString();

    // Labels for "what they viewed" come from the joined link/file.
    const rows = await all<Row>(
      c,
      `SELECT ce.company_name, ce.company_domain, ce.company_industry, ce.company_type, ce.asn_org, ce.is_vpn,
              ce.city, ce.country, ce.clicked_at,
              lc.anchor_text AS l_anchor, lc.original_url AS l_url, lc.short_code AS l_code, fa.filename AS f_name
       FROM click_events ce
       LEFT JOIN link_clicks lc ON ce.link_id = lc.id AND lc.user_id = ?
       LEFT JOIN file_assets fa ON ce.file_id = fa.id AND fa.user_id = ?
       WHERE (lc.id IS NOT NULL OR fa.id IS NOT NULL) AND ce.clicked_at >= ?`,
      [user.userId, user.userId, cutoff],
    );

    interface Entry {
      name: string;
      domain: string | null;
      industry: string | null;
      source: string;
      opens: number;
      last_seen: string | null;
      last_ms: number | null;
      last_asset: string | null;
      city: string | null;
      country: string | null;
    }
    // Aggregate by company. Prefer firmographic data; fall back to the ASN owner.
    const agg = new Map<string, Entry>();
    for (const r of rows) {
      if (r.is_vpn) continue;
      let key: string, name: string, domain: string | null, industry: string | null, source: string;
      const companyName = r.company_name as string | null;
      const asnOrg = r.asn_org as string | null;
      if (companyName) {
        if (["isp", "hosting", "vpn"].includes(((r.company_type as string | null) || "").toLowerCase())) continue;
        key = ((r.company_domain as string | null) || companyName).toLowerCase();
        [name, domain, industry, source] = [
          companyName,
          (r.company_domain as string | null) ?? null,
          (r.company_industry as string | null) ?? null,
          "firmographic",
        ];
      } else if (asnOrg && !looksLikeNetworkNoise(asnOrg)) {
        key = asnOrg.toLowerCase();
        [name, domain, industry, source] = [asnOrg, null, null, "network"];
      } else continue;

      const linkLabel = (r.l_anchor as string | null) || (r.l_url as string | null) || (r.l_code as string | null);
      const label = linkLabel || (r.f_name as string | null) || null;
      let e = agg.get(key);
      if (!e) {
        e = { name, domain, industry, source, opens: 0, last_seen: null, last_ms: null, last_asset: null, city: null, country: null };
        agg.set(key, e);
      }
      e.opens += 1;
      const ms = parseIso(r.clicked_at as string | null)?.getTime() ?? null;
      if (e.last_seen === null || (ms !== null && e.last_ms !== null && ms > e.last_ms)) {
        e.last_seen = r.clicked_at as string;
        e.last_ms = ms;
        e.last_asset = label;
        e.city = (r.city as string | null) ?? null;
        e.country = (r.country as string | null) ?? null;
      }
    }

    const companies = [...agg.values()].map((e) => {
      const lastMs = e.last_ms ?? now;
      const recencyDays = Math.max(0, (now - lastMs) / 86_400_000);
      return {
        name: e.name,
        domain: e.domain,
        industry: e.industry,
        source: e.source,
        opens: e.opens,
        last_seen: isoUtc(e.last_seen),
        last_asset: e.last_asset,
        city: e.city,
        country: e.country,
        temperature: intentTemperature(recencyDays, e.opens),
      };
    });
    companies.sort((a, b) => TEMP_RANK[a.temperature] - TEMP_RANK[b.temperature] || b.opens - a.opens);
    return c.json({ provider, companies: companies.slice(0, q.limit) });
  });

  // ==========================================================================
  // Opens geo map — where the caller's links & files are being opened
  // ==========================================================================

  router.get("/analytics/geo", async (c) => {
    const user = await requireAuth(c);
    const q = parseQuery(c, z.object({ days: qInt(30, { ge: 1, le: 365 }), limit: qInt(100, { ge: 1, le: 500 }) }));
    const cutoff = new Date(Date.now() - q.days * 86_400_000).toISOString();
    const base = `${OWNED_EVENT} AND ce.clicked_at >= ?`;
    const params: Param[] = [user.userId, user.userId, cutoff];

    const [total, countries, cities, byDay] = await Promise.all([
      first<Row>(c, `SELECT COUNT(ce.id) AS n FROM click_events ce WHERE ${base}`, params),
      all(
        c,
        `SELECT ce.country AS country, ce.country_code AS country_code, COUNT(ce.id) AS opens,
                COUNT(DISTINCT ce.ip_address) AS uniq
         FROM click_events ce WHERE ${base} AND ce.country IS NOT NULL
         GROUP BY ce.country, ce.country_code ORDER BY COUNT(ce.id) DESC LIMIT ?`,
        [...params, q.limit],
      ),
      all(
        c,
        `SELECT ce.city AS city, ce.country AS country, COUNT(ce.id) AS opens
         FROM click_events ce WHERE ${base} AND ce.city IS NOT NULL
         GROUP BY ce.city, ce.country ORDER BY COUNT(ce.id) DESC LIMIT ?`,
        [...params, q.limit],
      ),
      all(
        c,
        `SELECT substr(ce.clicked_at, 1, 10) AS day, COUNT(ce.id) AS opens
         FROM click_events ce WHERE ${base} GROUP BY substr(ce.clicked_at, 1, 10) ORDER BY substr(ce.clicked_at, 1, 10)`,
        params,
      ),
    ]);

    return c.json({
      total_opens: num(total?.n),
      countries: countries.map((r) => ({
        country: r.country,
        country_code: r.country_code ?? null,
        opens: num(r.opens),
        unique_opens: num(r.uniq),
      })),
      cities: cities.map((r) => ({ city: r.city, country: r.country ?? null, opens: num(r.opens) })),
      by_day: byDay.map((r) => ({ date: String(r.day), opens: num(r.opens) })),
    });
  });

  // ==========================================================================
  // Campaign-level analytics
  // ==========================================================================

  router.get("/analytics/campaigns", async (c) => {
    const user = await requireAuth(c);
    const q = parseQuery(c, z.object({ project_id: qStr(), ...rangeQuery(90) }));
    const [start, end] = resolveDateRange(q.days, q.start_date, q.end_date);
    const w = new Where()
      .add("user_id = ?", user.userId)
      .add("created_at >= ?", start)
      .add("created_at <= ?", end)
      .add("utm_campaign IS NOT NULL")
      .add("utm_campaign != ''");
    if (q.project_id) w.add("project_id IS ?", normUuid(q.project_id));

    const rows = await all(
      c,
      `SELECT utm_campaign, COUNT(id) AS total_links, COALESCE(SUM(click_count), 0) AS total_clicks,
              COALESCE(SUM(unique_clicks), 0) AS unique_clicks, MIN(created_at) AS first_link_created,
              MAX(last_clicked_at) AS last_click_at
       FROM link_clicks WHERE ${w.sql} GROUP BY utm_campaign ORDER BY SUM(click_count) DESC`,
      w.params,
    );
    return c.json(
      rows.map((r) => ({
        campaign: r.utm_campaign,
        total_links: num(r.total_links),
        total_clicks: num(r.total_clicks),
        unique_clicks: num(r.unique_clicks),
        click_rate: clickRate(num(r.unique_clicks), num(r.total_links)),
        first_link_created: isoUtc(r.first_link_created as string | null),
        last_click_at: isoUtc(r.last_click_at as string | null),
      })),
    );
  });

  // Registered before /analytics/campaigns/:campaign_name so "compare" isn't a campaign.
  router.get("/analytics/campaigns/compare", async (c) => {
    const user = await requireAuth(c);
    const q = parseQuery(c, z.object({ campaigns: z.string(), ...rangeQuery(90) }));
    const names = q.campaigns
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (names.length < 2 || names.length > 4) httpError(400, "Provide 2-4 campaign names separated by commas.");
    const [start, end] = resolveDateRange(q.days, q.start_date, q.end_date);

    const results = [];
    for (const name of names) {
      const agg = await first<Row>(
        c,
        `SELECT COUNT(id) AS total_links, COALESCE(SUM(click_count), 0) AS total_clicks,
                COALESCE(SUM(unique_clicks), 0) AS unique_clicks
         FROM link_clicks WHERE user_id = ? AND utm_campaign = ? AND created_at >= ? AND created_at <= ?`,
        [user.userId, name, start, end],
      );
      const w = new Where()
        .add("lc.user_id = ?", user.userId)
        .add("lc.utm_campaign = ?", name)
        .add("ce.clicked_at >= ?", start)
        .add("ce.clicked_at <= ?", end);
      const bucket = truncDay("ce.clicked_at");
      const [geo, devices, timeline] = await Promise.all([
        geoBreakdown(c, "country", w, 5),
        countBy(c, "ce.device_type", w, CE_JOIN_LC),
        all(
          c,
          `SELECT ${bucket} AS date, COUNT(ce.id) AS clicks FROM ${CE_JOIN_LC} WHERE ${w.sql}
           GROUP BY ${bucket} ORDER BY ${bucket}`,
          w.params,
        ),
      ]);
      const totalLinks = num(agg?.total_links);
      const unique = num(agg?.unique_clicks);
      results.push({
        campaign: name,
        total_links: totalLinks,
        total_clicks: num(agg?.total_clicks),
        unique_clicks: unique,
        click_rate: clickRate(unique, totalLinks),
        top_countries: geo,
        top_devices: devices.map((r) => ({ device_type: r.k, clicks: num(r.clicks) })),
        timeline: timeline.map((r) => ({ date: r.date ?? null, clicks: num(r.clicks) })),
      });
    }
    return c.json({ campaigns: results });
  });

  router.get("/analytics/campaigns/:campaign_name", async (c) => {
    const user = await requireAuth(c);
    const q = parseQuery(c, z.object({ project_id: qStr(), ...rangeQuery(90) }));
    const name = c.req.param("campaign_name");
    const [start, end] = resolveDateRange(q.days, q.start_date, q.end_date);
    const w = new Where()
      .add("user_id = ?", user.userId)
      .add("utm_campaign = ?", name)
      .add("created_at >= ?", start)
      .add("created_at <= ?", end);
    if (q.project_id) w.add("project_id IS ?", normUuid(q.project_id));

    const agg = await first<Row>(
      c,
      `SELECT COUNT(id) AS total_links, COALESCE(SUM(click_count), 0) AS total_clicks,
              COALESCE(SUM(unique_clicks), 0) AS unique_clicks FROM link_clicks WHERE ${w.sql}`,
      w.params,
    );
    const top = (col: string) =>
      all(
        c,
        `SELECT ${col} AS k, COALESCE(SUM(click_count), 0) AS clicks FROM link_clicks
         WHERE ${w.sql} AND ${col} IS NOT NULL GROUP BY ${col} ORDER BY SUM(click_count) DESC LIMIT 10`,
        w.params,
      );
    const [sources, mediums] = await Promise.all([top("utm_source"), top("utm_medium")]);
    const totalLinks = num(agg?.total_links);
    const unique = num(agg?.unique_clicks);
    return c.json({
      campaign: name,
      total_links: totalLinks,
      total_clicks: num(agg?.total_clicks),
      unique_clicks: unique,
      click_rate: clickRate(unique, totalLinks),
      sources: sources.map((r) => ({ source: r.k, clicks: num(r.clicks) })),
      mediums: mediums.map((r) => ({ medium: r.k, clicks: num(r.clicks) })),
    });
  });

  /** Click events of the caller's links in campaign `:campaign_name`, in range. */
  function campaignEvents(c: Ctx, userId: string, start: string, end: string): Where {
    return new Where()
      .add("lc.user_id = ?", userId)
      .add("lc.utm_campaign = ?", c.req.param("campaign_name") ?? "")
      .add("ce.clicked_at >= ?", start)
      .add("ce.clicked_at <= ?", end);
  }

  router.get("/analytics/campaigns/:campaign_name/geo", async (c) => {
    const user = await requireAuth(c);
    const q = parseQuery(c, z.object({ level: qDef("country"), ...rangeQuery(90) }));
    const [start, end] = resolveDateRange(q.days, q.start_date, q.end_date);
    return c.json(await geoBreakdown(c, q.level, campaignEvents(c, user.userId, start, end)));
  });

  router.get("/analytics/campaigns/:campaign_name/devices", async (c) => {
    const user = await requireAuth(c);
    const q = parseQuery(c, z.object(rangeQuery(90)));
    const [start, end] = resolveDateRange(q.days, q.start_date, q.end_date);
    const w = campaignEvents(c, user.userId, start, end);
    const [devices, browsers, os] = await Promise.all([
      countBy(c, "ce.device_type", w, CE_JOIN_LC),
      countBy(c, "ce.browser", w, CE_JOIN_LC, 10),
      countBy(c, "ce.os", w, CE_JOIN_LC, 10),
    ]);
    return c.json({
      devices: devices.map((r) => ({ device_type: r.k, clicks: num(r.clicks) })),
      browsers: browsers.map((r) => ({ browser: r.k, clicks: num(r.clicks) })),
      os: os.map((r) => ({ os: r.k, clicks: num(r.clicks) })),
    });
  });

  router.get("/analytics/campaigns/:campaign_name/links", async (c) => {
    const user = await requireAuth(c);
    const q = parseQuery(c, z.object(rangeQuery(90)));
    const [start, end] = resolveDateRange(q.days, q.start_date, q.end_date);
    const links = await all(
      c,
      `SELECT * FROM link_clicks WHERE user_id = ? AND utm_campaign = ? AND created_at >= ? AND created_at <= ?
       ORDER BY click_count DESC LIMIT 100`,
      [user.userId, c.req.param("campaign_name"), start, end],
    );
    const hosts = await domainHosts(c, links.map((l) => l.domain_id as string | null));
    const base = linkJson(c, hosts);
    return c.json(
      links.map((l) => ({
        ...base(l),
        utm_source: l.utm_source ?? null,
        utm_medium: l.utm_medium ?? null,
        click_count: num(l.click_count),
        unique_clicks: num(l.unique_clicks),
        created_at: isoUtc(l.created_at as string | null),
      })),
    );
  });

  router.get("/analytics/campaigns/:campaign_name/timeline", async (c) => {
    const user = await requireAuth(c);
    const q = parseQuery(c, z.object(rangeQuery(90)));
    const [start, end] = resolveDateRange(q.days, q.start_date, q.end_date);
    const w = campaignEvents(c, user.userId, start, end);
    const bucket = truncDay("ce.clicked_at");
    const rows = await all(
      c,
      `SELECT ${bucket} AS date, COUNT(ce.id) AS clicks, COUNT(DISTINCT ce.ip_address) AS unique_clicks
       FROM ${CE_JOIN_LC} WHERE ${w.sql} GROUP BY ${bucket} ORDER BY ${bucket}`,
      w.params,
    );
    return c.json({
      campaign: c.req.param("campaign_name"),
      data: rows.map((r) => ({ date: r.date ?? null, clicks: num(r.clicks), unique_clicks: num(r.unique_clicks) })),
    });
  });

  // ==========================================================================
  // Global geo
  // ==========================================================================

  router.get("/analytics/geo/overview", async (c) => {
    const user = await requireAuth(c);
    const q = parseQuery(
      c,
      z.object({ level: qDef("country"), project_id: qStr(), campaign: qStr(), ...rangeQuery(30) }),
    );
    const [start, end] = resolveDateRange(q.days, q.start_date, q.end_date);
    const w = new Where().add("lc.user_id = ?", user.userId).add("ce.clicked_at >= ?", start).add("ce.clicked_at <= ?", end);
    if (q.project_id) w.add("lc.project_id IS ?", normUuid(q.project_id));
    if (q.campaign) w.add("lc.utm_campaign = ?", q.campaign);
    return c.json(await geoBreakdown(c, q.level, w, 50));
  });

  // ==========================================================================
  // Exports (CSV)
  // ==========================================================================

  router.get("/analytics/export/events", async (c) => {
    const user = await requireAuth(c);
    const q = parseQuery(c, z.object({ project_id: qStr(), campaign: qStr(), ...rangeQuery(30) }));
    const [start, end] = resolveDateRange(q.days, q.start_date, q.end_date);
    const w = new Where().add("lc.user_id = ?", user.userId).add("ce.clicked_at >= ?", start).add("ce.clicked_at <= ?", end);
    if (q.project_id) w.add("lc.project_id IS ?", normUuid(q.project_id));
    if (q.campaign) w.add("lc.utm_campaign = ?", q.campaign);

    const rows = await all(
      c,
      `SELECT ce.clicked_at, lc.original_url, lc.short_code, lc.utm_source, lc.utm_medium, lc.utm_campaign,
              lc.utm_content, lc.utm_term, ce.ip_address, ce.country, ce.region, ce.city, ce.device_type,
              ce.browser, ce.os, ce.referrer, ce.is_vpn, ce.asn_org
       FROM ${CE_JOIN_LC} WHERE ${w.sql} ORDER BY ce.clicked_at DESC LIMIT 10000`,
      w.params,
    );
    let out = toCsvRow([
      "clicked_at", "original_url", "short_code",
      "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term",
      "ip_address", "country", "region", "city",
      "device_type", "browser", "os", "referrer", "is_vpn", "asn_org",
    ]);
    const s = (v: unknown) => (v == null ? null : String(v));
    for (const r of rows) {
      out += toCsvRow([
        isoUtc(r.clicked_at as string) ?? "",
        s(r.original_url), s(r.short_code),
        s(r.utm_source), s(r.utm_medium), s(r.utm_campaign), s(r.utm_content), s(r.utm_term),
        s(r.ip_address), s(r.country), s(r.region), s(r.city),
        s(r.device_type), s(r.browser), s(r.os), s(r.referrer),
        r.is_vpn ? "true" : "false",
        s(r.asn_org) || "",
      ]);
    }
    return csvResponse(out, "click_events.csv");
  });

  router.get("/analytics/export/campaign-summary", async (c) => {
    const user = await requireAuth(c);
    const q = parseQuery(c, z.object(rangeQuery(90)));
    const [start, end] = resolveDateRange(q.days, q.start_date, q.end_date);
    const rows = await all(
      c,
      `SELECT utm_campaign, COUNT(id) AS total_links, COALESCE(SUM(click_count), 0) AS total_clicks,
              COALESCE(SUM(unique_clicks), 0) AS unique_clicks, MIN(created_at) AS first_created,
              MAX(last_clicked_at) AS last_clicked
       FROM link_clicks WHERE user_id = ? AND created_at >= ? AND created_at <= ? AND utm_campaign IS NOT NULL
       GROUP BY utm_campaign ORDER BY SUM(click_count) DESC`,
      [user.userId, start, end],
    );
    let out = toCsvRow(["campaign", "total_links", "total_clicks", "unique_clicks", "click_rate", "first_created", "last_clicked"]);
    for (const r of rows) {
      const links = num(r.total_links);
      const unique = num(r.unique_clicks);
      out += toCsvRow([
        r.utm_campaign as string,
        String(links),
        String(num(r.total_clicks)),
        String(unique),
        pyFloatStr(clickRate(unique, links)),
        isoUtc(r.first_created as string | null) ?? "",
        isoUtc(r.last_clicked as string | null) ?? "",
      ]);
    }
    return csvResponse(out, "campaign_summary.csv");
  });

  router.get("/analytics/export/link-performance", async (c) => {
    const user = await requireAuth(c);
    const q = parseQuery(c, z.object({ project_id: qStr(), ...rangeQuery(30) }));
    const [start, end] = resolveDateRange(q.days, q.start_date, q.end_date);
    const w = new Where().add("user_id = ?", user.userId).add("created_at >= ?", start).add("created_at <= ?", end);
    if (q.project_id) w.add("project_id IS ?", normUuid(q.project_id));
    const rows = await all(c, `SELECT * FROM link_clicks WHERE ${w.sql} ORDER BY click_count DESC LIMIT 10000`, w.params);
    let out = toCsvRow([
      "original_url", "tracked_url", "short_code",
      "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term",
      "project_name", "click_count", "unique_clicks", "created_at",
    ]);
    const s = (v: unknown) => (v == null ? null : String(v));
    for (const l of rows) {
      out += toCsvRow([
        s(l.original_url), s(l.tracked_url), s(l.short_code),
        s(l.utm_source), s(l.utm_medium), s(l.utm_campaign), s(l.utm_content), s(l.utm_term),
        s(l.project_name), String(num(l.click_count)), String(num(l.unique_clicks)),
        isoUtc(l.created_at as string | null) ?? "",
      ]);
    }
    return csvResponse(out, "link_performance.csv");
  });

  // ==========================================================================
  // Real-time click notifications (polling)
  // ==========================================================================

  router.get("/analytics/clicks/recent", async (c) => {
    const user = await requireAuth(c);
    const q = parseQuery(c, z.object({ since: qStr() }));
    let since: string;
    if (q.since) {
      // Python parsed the value then dropped its tz offset (DB holds naive UTC).
      const parsed = naiveIso(q.since.replace(/Z/g, "+00:00"));
      if (!parsed) httpError(400, "Invalid timestamp format");
      since = parsed!;
    } else {
      since = new Date(Date.now() - 5 * 60_000).toISOString();
    }

    // Outer-join both attribution tables so file opens (file_id set, link_id
    // null) appear in the feed alongside link clicks.
    const rows = await all(
      c,
      `SELECT ce.id, ce.clicked_at, ce.country, ce.region, ce.device_type, ce.browser, ce.link_id, ce.file_id,
              lc.original_url, lc.short_code AS link_short_code, lc.utm_campaign, lc.utm_source,
              fa.filename, fa.short_code AS file_short_code
       FROM click_events ce
       LEFT JOIN link_clicks lc ON ce.link_id = lc.id
       LEFT JOIN file_assets fa ON ce.file_id = fa.id
       WHERE (lc.user_id = ? OR fa.user_id = ?) AND ce.clicked_at > ?
       ORDER BY ce.clicked_at DESC LIMIT 50`,
      [user.userId, user.userId, since],
    );
    return c.json(
      rows.map((r) => ({
        id: r.id,
        type: r.file_id ? "file" : "link",
        clicked_at: isoUtc(r.clicked_at as string),
        country: r.country ?? null,
        region: r.region ?? null,
        device_type: r.device_type ?? null,
        browser: r.browser ?? null,
        // Link fields (null for file opens)
        original_url: r.original_url ?? null,
        utm_campaign: r.utm_campaign ?? null,
        utm_source: r.utm_source ?? null,
        link_id: r.link_id ?? null,
        // File fields (null for link clicks)
        filename: r.filename ?? null,
        file_id: r.file_id ?? null,
        // short_code resolves to whichever asset this event belongs to
        short_code: (r.file_id ? r.file_short_code : r.link_short_code) ?? null,
      })),
    );
  });
}
