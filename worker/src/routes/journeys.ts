/**
 * /api/v1/analytics/journeys: every touch one visitor made across the caller's
 * links and files, in time order, with location (to draw on a map).
 *
 * Rules: only real clicks (REAL_CLICK, the same predicate company-intent uses);
 * scope = reportScope() (report.own / report.team / report.org); rows without a
 * visitor_id cannot form a journey and are counted as meta.unattributed; the
 * query never selects ip_address or user_agent.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Ctx } from "../env";
import { requireAuth, type TokenData } from "../auth/security";
import { httpError } from "../lib/errors";
import { isoUtc } from "../lib/time";
import { parseQuery } from "../lib/validate";
import { buildShareUrl } from "../services/content";
import { reportScope } from "../services/reporting";
import { REAL_CLICK, buildRedirectUrl, domainHosts, normUuid, num } from "./_utmHelpers";

export const router = new Hono<AppEnv>({ strict: false });

type Row = Record<string, any>;
type Param = string | number | null;

const COLLAPSE_MS = 30 * 60_000;
const qInt = (def: number, ge: number, le: number) => z.coerce.number().int().min(ge).max(le).default(def);

const all = async (c: Ctx, sql: string, params: Param[]): Promise<Row[]> =>
  (await c.env.DB.prepare(sql).bind(...params).all<Row>()).results ?? [];

/** Which assets the caller may read: a SQL predicate per table alias plus its binds. */
async function assetScope(c: Ctx, user: TokenData) {
  const scope = user.orgUuid ? await reportScope(c.var.db, user) : { kind: "own", userIds: new Set([user.userId]) };
  if (scope.kind === "none") httpError(403, "You do not have reporting access in this organization.");
  if (scope.userIds === null) {
    return { sql: (a: string) => `(${a}.organization_id = ? OR ${a}.user_id = ?)`, params: [user.orgUuid!, user.userId] as Param[] };
  }
  return { sql: (a: string) => `${a}.user_id IN (SELECT value FROM json_each(?))`, params: [JSON.stringify([...scope.userIds])] as Param[] };
}

const FROM = `click_events ce LEFT JOIN link_clicks lc ON lc.id = ce.link_id LEFT JOIN file_assets fa ON fa.id = ce.file_id`;

/** Journey list for `visitors` over every in-scope asset, plus the dwell rows. */
async function buildJourneys(c: Ctx, scope: Awaited<ReturnType<typeof assetScope>>, visitors: string[], cutoff: string) {
  if (!visitors.length) return [];
  const vj = JSON.stringify(visitors);
  const events = await all(
    c,
    `SELECT ce.visitor_id, ce.clicked_at, ce.link_id, ce.file_id, ce.city, ce.region, ce.country, ce.country_code,
            ce.latitude, ce.longitude, ce.device_type, ce.browser, ce.is_revisit, ce.is_vpn, ce.company_name, ce.company_type,
            lc.anchor_text, lc.original_url, lc.short_code AS l_code, lc.domain_id AS l_dom,
            fa.filename, fa.short_code AS f_code, fa.domain_id AS f_dom
     FROM ${FROM}
     WHERE ce.visitor_id IN (SELECT value FROM json_each(?)) AND ce.clicked_at >= ? AND ${REAL_CLICK}
       AND ((lc.id IS NOT NULL AND ${scope.sql("lc")}) OR (fa.id IS NOT NULL AND ${scope.sql("fa")}))
     ORDER BY ce.clicked_at ASC`,
    [vj, cutoff, ...scope.params, ...scope.params],
  );
  const dwell = await all(
    c,
    `SELECT pe.visitor_id, pe.file_id, pe.dwell_ms, pe.created_at FROM page_engagements pe
     JOIN file_assets fa ON fa.id = pe.file_id
     WHERE pe.visitor_id IN (SELECT value FROM json_each(?)) AND pe.created_at >= ? AND ${scope.sql("fa")}`,
    [vj, cutoff, ...scope.params],
  );
  const hosts = await domainHosts(c, events.map((e) => (e.link_id ? e.l_dom : e.f_dom)));
  const settings = c.var.settings;

  interface T { touch: Record<string, unknown>; startMs: number; lastMs: number; key: string }
  const byVisitor = new Map<string, { ts: T[]; events: Row[] }>();
  for (const e of events) {
    const j = byVisitor.get(e.visitor_id) ?? { ts: [], events: [] };
    byVisitor.set(e.visitor_id, j);
    j.events.push(e);
    const ms = Date.parse(e.clicked_at);
    const type = e.link_id ? "link" : "file";
    const id = e.link_id ?? e.file_id;
    const key = `${type}:${id}`;
    const last = j.ts.at(-1);
    if (last && last.key === key && ms - last.lastMs <= COLLAPSE_MS) {
      last.lastMs = ms;
      (last.touch.count as number)++;
      if (e.is_vpn) last.touch.is_vpn = true;
      continue;
    }
    const host = hosts.get(e.link_id ? e.l_dom : e.f_dom);
    const asset = e.link_id
      ? { type, id, title: e.anchor_text || e.original_url, url: buildRedirectUrl(c, e.l_code, host) }
      : { type, id, title: e.filename, url: buildShareUrl(settings, { file: { shortCode: e.f_code, filename: e.filename }, hostname: host }) };
    j.ts.push({
      key,
      startMs: ms,
      lastMs: ms,
      touch: {
        at: isoUtc(e.clicked_at), asset, city: e.city ?? null, region: e.region ?? null, country: e.country ?? null,
        country_code: e.country_code ?? null, lat: e.latitude ?? null, lon: e.longitude ?? null,
        device_type: e.device_type ?? null, browser: e.browser ?? null, is_revisit: !!e.is_revisit, is_vpn: !!e.is_vpn,
        dwell_ms: null, count: 1,
      },
    });
  }

  // Each engagement belongs to the latest touch on that file that started before it (else the first).
  for (const d of dwell) {
    const mine = byVisitor.get(d.visitor_id)?.ts.filter((t) => t.key === `file:${d.file_id}`);
    if (!mine?.length) continue;
    const ms = Date.parse(d.created_at);
    const t = mine.filter((x) => x.startMs <= ms).at(-1) ?? mine[0];
    t.touch.dwell_ms = ((t.touch.dwell_ms as number | null) ?? 0) + num(d.dwell_ms);
  }

  return visitors.flatMap((v) => {
    const j = byVisitor.get(v);
    if (!j) return [];
    const cities = new Set(j.events.filter((e) => e.city).map((e) => `${e.city}|${e.country_code ?? ""}`)).size;
    const company = j.events.find((e) => e.company_name && !["isp", "hosting", "vpn"].includes((e.company_type ?? "").toLowerCase()));
    return [{
      visitor_id: v,
      first_at: isoUtc(j.events[0].clicked_at),
      last_at: isoUtc(j.events.at(-1)!.clicked_at),
      touches: j.ts.map((t) => t.touch),
      cities,
      forwarded: cities >= 2,
      company_name: company?.company_name ?? null,
    }];
  });
}

const cutoffFor = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const HAS_VISITOR = "COALESCE(ce.visitor_id, '') != ''";

router.get("/journeys", async (c) => {
  const user = await requireAuth(c);
  const q = parseQuery(
    c,
    z.object({ asset_type: z.enum(["link", "file"]), asset_id: z.string(), days: qInt(90, 1, 365), limit: qInt(20, 1, 100) }),
  );
  const id = normUuid(q.asset_id);
  const scope = await assetScope(c, user);
  const table = q.asset_type === "link" ? "link_clicks" : "file_assets";
  const owned = id && (await all(c, `SELECT 1 FROM ${table} x WHERE x.id = ? AND ${scope.sql("x")}`, [id, ...scope.params])).length;
  if (!owned) httpError(404, q.asset_type === "link" ? "Link not found" : "File not found");

  const cutoff = cutoffFor(q.days);
  const col = q.asset_type === "link" ? "ce.link_id" : "ce.file_id";
  const base = `FROM click_events ce WHERE ${col} = ? AND ce.clicked_at >= ? AND ${REAL_CLICK}`;
  const [visitors, missing] = await Promise.all([
    all(c, `SELECT ce.visitor_id AS v ${base} AND ${HAS_VISITOR} GROUP BY ce.visitor_id ORDER BY MAX(ce.clicked_at) DESC LIMIT ?`, [id!, cutoff, q.limit]),
    all(c, `SELECT COUNT(*) AS n ${base} AND NOT ${HAS_VISITOR}`, [id!, cutoff]),
  ]);
  return c.json({
    journeys: await buildJourneys(c, scope, visitors.map((r) => r.v), cutoff),
    meta: { days: q.days, unattributed: num(missing[0]?.n) },
  });
});

router.get("/journeys/top", async (c) => {
  const user = await requireAuth(c);
  const q = parseQuery(c, z.object({ days: qInt(30, 1, 365), limit: qInt(10, 1, 100) }));
  const scope = await assetScope(c, user);
  const cutoff = cutoffFor(q.days);
  const where = `${FROM} WHERE ce.clicked_at >= ? AND ${REAL_CLICK}
    AND ((lc.id IS NOT NULL AND ${scope.sql("lc")}) OR (fa.id IS NOT NULL AND ${scope.sql("fa")}))`;
  const binds = [cutoff, ...scope.params, ...scope.params];
  const [visitors, missing] = await Promise.all([
    all(
      c,
      `SELECT ce.visitor_id AS v FROM ${where} AND ${HAS_VISITOR} GROUP BY ce.visitor_id
       ORDER BY COUNT(DISTINCT NULLIF(ce.city, '') || '|' || COALESCE(ce.country_code, '')) DESC, COUNT(*) DESC, MAX(ce.clicked_at) DESC LIMIT ?`,
      [...binds, q.limit],
    ),
    all(c, `SELECT COUNT(*) AS n FROM ${where} AND NOT ${HAS_VISITOR}`, binds),
  ]);
  return c.json({
    journeys: await buildJourneys(c, scope, visitors.map((r) => r.v), cutoff),
    meta: { days: q.days, unattributed: num(missing[0]?.n) },
  });
});
