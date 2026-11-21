import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { requireAuth } from "../auth/security";
import { httpError } from "../lib/errors";
import { parseQuery, qInt, qStr } from "../lib/validate";
import { reportScope } from "../services/reporting";
import { dateRange } from "./_files";
import { REAL_CLICK } from "./_utmHelpers";

export const router = new Hono<AppEnv>({ strict: false });

router.get("/assets", async (c) => {
  const user = await requireAuth(c);
  const q = parseQuery(c, z.object({
    days: qInt(30, { ge: 1, le: 365 }), start_date: qStr(), end_date: qStr(),
    scope: z.enum(["own", "workspace"]).default("own"),
  }));
  if (!!q.start_date !== !!q.end_date) httpError(400, "Supply both start_date and end_date.");
  const [start, end] = dateRange(q.days ?? 30, q.start_date, q.end_date);
  if (Date.parse(end) - Date.parse(start) > 366 * 86_400_000) httpError(400, "Choose a date range of at most one year.");
  let owner = "fa.user_id = ?";
  let ownerParams: (string | null)[] = [user.userId];
  if (q.scope === "workspace") {
    if (!user.orgUuid) httpError(403, "Select an organization for workspace reporting.");
    const scope = await reportScope(c.var.db, user);
    if (scope.kind === "none" || scope.kind === "own") httpError(403, "Workspace reporting permission required.");
    owner = scope.userIds === null ? "1 = 1" : "fa.user_id IN (SELECT value FROM json_each(?))";
    ownerParams = scope.userIds === null ? [] : [JSON.stringify([...scope.userIds])];
  }
  // Both the membership scope and the asset's workspace must match, never just its owner.
  const assetWhere = `fa.status != 'deleted' AND fa.organization_id IS ? AND ${owner}`;
  const params = [user.orgUuid ?? null, ...ownerParams, start, end];
  const cte = `WITH assets AS (
    SELECT fa.id, fa.filename, fa.kind, CASE WHEN fa.share_intent = 'host' OR (fa.share_intent IS NULL AND fa.kind = 'html') THEN 'page' ELSE 'file' END AS asset_type
    FROM file_assets fa WHERE ${assetWhere}
  ), events AS (
    SELECT ce.*, a.asset_type FROM click_events ce JOIN assets a ON a.id = ce.file_id
    WHERE julianday(ce.clicked_at) BETWEEN julianday(?) AND julianday(?) AND ${REAL_CLICK}
  )`;
  const unique = "COUNT(DISTINCT COALESCE(NULLIF(visitor_id, ''), CASE WHEN ip_address IS NOT NULL THEN 'ip:' || ip_address END))";
  const query = (sql: string) => c.env.DB.prepare(`${cte} ${sql}`).bind(...params);
  const [summary, assets, daily, hours, countries, devices, referrers, companies] = await c.env.DB.batch([
    query(`SELECT COUNT(*) AS opens, ${unique} AS unique_visitors, COALESCE(SUM(is_revisit),0) AS returning_opens,
      SUM(CASE WHEN asset_type = 'page' THEN 1 ELSE 0 END) AS page_opens,
      SUM(CASE WHEN asset_type = 'file' THEN 1 ELSE 0 END) AS file_opens,
      (SELECT COUNT(*) FROM assets) AS asset_count FROM events`),
    query(`SELECT a.id, a.filename, a.asset_type, COUNT(e.id) AS opens,
      COUNT(DISTINCT COALESCE(NULLIF(e.visitor_id, ''), CASE WHEN e.ip_address IS NOT NULL THEN 'ip:' || e.ip_address END)) AS unique_visitors,
      COALESCE(SUM(e.is_revisit),0) AS returning_opens, MAX(e.clicked_at) AS last_opened_at
      FROM assets a LEFT JOIN events e ON e.file_id = a.id GROUP BY a.id ORDER BY opens DESC, a.filename LIMIT 50`),
    query("SELECT date(clicked_at) AS day, COUNT(*) AS opens FROM events GROUP BY day ORDER BY day"),
    query("SELECT CAST(strftime('%w',clicked_at) AS INTEGER) AS weekday, CAST(strftime('%H',clicked_at) AS INTEGER) AS hour, COUNT(*) AS opens FROM events GROUP BY weekday,hour ORDER BY weekday,hour"),
    query("SELECT COALESCE(NULLIF(country,''),'Unknown') AS label, COUNT(*) AS opens FROM events GROUP BY label ORDER BY opens DESC LIMIT 10"),
    query("SELECT COALESCE(NULLIF(device_type,''),'Unknown') AS label, COUNT(*) AS opens FROM events GROUP BY label ORDER BY opens DESC LIMIT 10"),
    query("SELECT COALESCE(NULLIF(referrer,''),'Direct or unavailable') AS label, COUNT(*) AS opens FROM events GROUP BY label ORDER BY opens DESC LIMIT 10"),
    query("SELECT company_name AS label, COUNT(*) AS opens FROM events WHERE company_name IS NOT NULL AND company_name != '' AND COALESCE(lower(company_type),'') NOT IN ('isp','hosting','vpn') GROUP BY label ORDER BY opens DESC LIMIT 10"),
  ]);
  return c.json({
    summary: summary.results[0], assets: assets.results, daily: daily.results, hours: hours.results,
    countries: countries.results, devices: devices.results, referrers: referrers.results, companies: companies.results,
    meta: { start, end, timezone: "UTC", scope: q.scope, asset_limit: 50,
      visitor_basis: "Estimated browsers, with IP fallback when a visitor ID is unavailable. Shared networks and VPNs are not individual people.",
      filtering: "Known bots and scanner user agents excluded. Automated traffic may still be present." },
  });
});
