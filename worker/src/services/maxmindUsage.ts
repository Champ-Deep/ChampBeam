/**
 * MaxMind web-service usage, remaining credit and spend. Port of
 * backend/app/services/maxmind_usage.py.
 *
 * Every GeoIP2 web-service response carries MaxMind's own `queries_remaining`
 * counter, so the credit balance is free to observe — there is no billing API to
 * call and no extra request to pay for. We record it alongside our own per-day
 * lookup counts, which together give burn rate, projected exhaustion and spend.
 *
 * Every write here fails open: geo enrichment must never break because usage
 * bookkeeping had a bad day.
 *
 * Exports:
 *   recordLookup(db: Db, { queriesRemaining: number | null, ok: boolean }): Promise<void>   (never throws)
 *   creditStatus(settings: Settings, remaining: number | null): "unknown"|"critical"|"warning"|"ok"   (_status)
 *   usageSummary(db: Db, settings: Settings, { days = 30 }): Promise<MaxmindUsageSummary>
 *   type MaxmindUsageSummary
 */
import { asc, desc, gte, isNotNull, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { maxmindUsage } from "../db/schema";
import type { Settings } from "../env";
import { isoUtc, nowIso } from "../lib/time";

const todayKey = (d: Date = new Date()) => d.toISOString().slice(0, 10);

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return todayKey(d);
}

/** Count one web-service call against today and store the latest balance. Never throws. */
export async function recordLookup(
  db: Db,
  { queriesRemaining, ok }: { queriesRemaining: number | null | undefined; ok: boolean },
): Promise<void> {
  try {
    const now = nowIso();
    const okInc = ok ? 1 : 0;
    const errInc = ok ? 0 : 1;
    const rem = queriesRemaining ?? null;
    await db.run(sql`
      INSERT INTO maxmind_usage (day, lookups, errors, queries_remaining, updated_at)
      VALUES (${todayKey()}, ${okInc}, ${errInc}, ${rem}, ${now})
      ON CONFLICT (day) DO UPDATE SET
        lookups = maxmind_usage.lookups + ${okInc},
        errors  = maxmind_usage.errors  + ${errInc},
        queries_remaining = COALESCE(${rem}, maxmind_usage.queries_remaining),
        updated_at = ${now}`);
  } catch (err) {
    console.debug("MaxMind usage bookkeeping failed", err);
  }
}

/** Grade a credit balance against the configured thresholds (Python `_status`). */
export function creditStatus(settings: Settings, remaining: number | null | undefined): string {
  if (remaining == null) return "unknown";
  if (remaining <= settings.maxmindCreditCritThreshold) return "critical";
  if (remaining <= settings.maxmindCreditWarnThreshold) return "warning";
  return "ok";
}

export interface MaxmindUsageSummary {
  configured: boolean;
  endpoint: string;
  queries_remaining: number | null;
  balance_as_of: string | null;
  status: string;
  warn_threshold: number;
  critical_threshold: number;
  lookups_today: number;
  lookups_window: number;
  window_days: number;
  errors_window: number;
  avg_daily: number;
  days_left: number | null;
  projected_exhaustion: string | null;
  lifetime_lookups: number;
  lifetime_errors: number;
  unit_price_usd: number;
  spend_window_usd: number | null;
  spend_lifetime_usd: number | null;
  daily: { day: string; lookups: number; errors: number; queries_remaining: number | null }[];
}

const round = (v: number, digits: number) => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

/**
 * Balance, burn rate, projected exhaustion and spend.
 * `days` bounds the burn-rate window only; lifetime totals are unbounded.
 */
export async function usageSummary(
  db: Db,
  settings: Settings,
  { days = 30 }: { days?: number } = {},
): Promise<MaxmindUsageSummary> {
  const today = todayKey();
  const since = addDays(today, -(days - 1));

  const rows = await db.select().from(maxmindUsage).where(gte(maxmindUsage.day, since)).orderBy(asc(maxmindUsage.day)).all();
  const latest = await db
    .select()
    .from(maxmindUsage)
    .where(isNotNull(maxmindUsage.queriesRemaining))
    .orderBy(desc(maxmindUsage.updatedAt))
    .limit(1)
    .get();
  const lifetime = await db
    .select({
      lookups: sql<number>`COALESCE(SUM(${maxmindUsage.lookups}), 0)`,
      errors: sql<number>`COALESCE(SUM(${maxmindUsage.errors}), 0)`,
    })
    .from(maxmindUsage)
    .get();

  const windowLookups = rows.reduce((a, r) => a + r.lookups, 0);
  const todayLookups = rows.find((r) => r.day === today)?.lookups ?? 0;

  // Average over days actually observed, not the whole window — a service
  // switched on last week must not look like it burns 1/30th of its real rate.
  const observedDays = Math.max(1, new Set(rows.filter((r) => r.lookups).map((r) => r.day)).size);
  const avgDaily = windowLookups ? windowLookups / observedDays : 0;

  const remaining = latest ? latest.queriesRemaining : null;
  const daysLeft = remaining != null && avgDaily > 0 ? Math.trunc(remaining / avgDaily) : null;
  const exhaustion = daysLeft != null ? addDays(today, daysLeft) : null;

  const lifetimeLookups = Number(lifetime?.lookups ?? 0);
  const lifetimeErrors = Number(lifetime?.errors ?? 0);
  const price = settings.maxmindUnitPriceUsd || 0;
  return {
    configured: settings.maxmindWsConfigured,
    endpoint: settings.maxmindWsEndpoint,
    queries_remaining: remaining,
    balance_as_of: latest ? isoUtc(latest.updatedAt) : null,
    status: creditStatus(settings, remaining),
    warn_threshold: settings.maxmindCreditWarnThreshold,
    critical_threshold: settings.maxmindCreditCritThreshold,
    lookups_today: todayLookups,
    lookups_window: windowLookups,
    window_days: days,
    errors_window: rows.reduce((a, r) => a + r.errors, 0),
    avg_daily: round(avgDaily, 1),
    days_left: daysLeft,
    projected_exhaustion: exhaustion,
    lifetime_lookups: lifetimeLookups,
    lifetime_errors: lifetimeErrors,
    unit_price_usd: price,
    spend_window_usd: price ? round(windowLookups * price, 2) : null,
    spend_lifetime_usd: price ? round(lifetimeLookups * price, 2) : null,
    daily: rows.map((r) => ({
      day: r.day,
      lookups: r.lookups,
      errors: r.errors,
      queries_remaining: r.queriesRemaining,
    })),
  };
}
