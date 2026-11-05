/**
 * System / operations endpoints. Port of backend/app/api/v1/system.py —
 * mounted at /api/v1/system.
 *
 * Read-only vitals for the people who run the platform: third-party quota,
 * spend and the checks a health monitor needs. Accepts API keys (not just
 * interactive sessions) so the uptime monitor can poll it with a scoped key.
 */
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth } from "../auth/security";
import type { AppEnv } from "../env";
import { parseQuery, qInt } from "../lib/validate";
import { usageSummary } from "../services/maxmindUsage";

export const router = new Hono<AppEnv>({ strict: false });

/**
 * MaxMind GeoIP2 credit balance, burn rate, projected exhaustion and spend.
 * The balance comes from MaxMind's own `queries_remaining`, carried on every
 * web-service response — it costs no extra query to read.
 */
router.get("/maxmind", async (c) => {
  await requireAuth(c);
  const { days } = parseQuery(c, z.object({ days: qInt(30, { ge: 1, le: 365 }) }));
  return c.json(await usageSummary(c.var.db, c.var.settings, { days }));
});

/**
 * One call a health monitor can grade: database plus every metered
 * dependency. `ok` is false when anything needs a human.
 */
router.get("/status", async (c) => {
  await requireAuth(c);
  const checks: Record<string, Record<string, unknown>> = {};

  try {
    await c.env.DB.prepare("SELECT 1").first();
    checks.database = { status: "ok" };
  } catch (err) {
    checks.database = { status: "critical", detail: String(err).slice(0, 200) };
  }

  try {
    const mm = await usageSummary(c.var.db, c.var.settings, { days: 30 });
    checks.maxmind = {
      // "off" is a deliberate configuration, not a fault — a monitor must not
      // page about a service this deployment was never meant to call.
      status: mm.configured ? mm.status : "off",
      configured: mm.configured,
      queries_remaining: mm.queries_remaining,
      avg_daily: mm.avg_daily,
      days_left: mm.days_left,
      projected_exhaustion: mm.projected_exhaustion,
    };
  } catch (err) {
    checks.maxmind = { status: "unknown", detail: String(err).slice(0, 200) };
  }

  const bad = new Set(["critical", "warning"]);
  return c.json({
    ok: !Object.values(checks).some((ch) => bad.has(ch.status as string)),
    checks,
  });
});
