/**
 * Scheduled work — replaces the asyncio loops started in main.py's lifespan
 * (expiry_sweeper_loop, domain_provision_loop) plus housekeeping for the D1
 * rate counters that replaced Redis TTLs. Schedules live in wrangler.jsonc.
 */
import type { Env } from "./env";
import { getSettings } from "./env";
import { getDb } from "./db/client";
import { purgeExpiredCounters } from "./lib/ratelimit";
import { sweepExpiredFiles } from "./services/fileExpiry";
import { refreshPendingDomains } from "./services/domainProvisioning";
import { runIntranetSweep } from "./intranet/sweep";
import { reportError } from "./lib/observability";

export async function runScheduled(cron: string, env: Env): Promise<void> {
  const settings = getSettings(env);
  const db = getDb(env.DB);
  if (settings.intranetMode) {
    // The intranet serves no custom domains or marketing files: only its own sweeper runs.
    try {
      await runIntranetSweep(env, settings);
    } catch (err) {
      reportError(`cron ${cron}: intranet sweep failed`, err, { component: "cron", tags: { cron, job: "intranet sweep" } });
    }
    try {
      await purgeExpiredCounters(env.DB);
    } catch (err) {
      reportError(`cron ${cron}: rate counter purge failed`, err, { component: "cron", tags: { cron, job: "rate counter purge" } });
    }
    return;
  }
  const jobs: [string, () => Promise<unknown>][] =
    cron === "*/5 * * * *"
      ? [["domain refresh", () => refreshPendingDomains(env, settings, db)]]
      : [
          ["file expiry sweep", () => sweepExpiredFiles(env, settings, db)],
          ["rate counter purge", () => purgeExpiredCounters(env.DB)],
        ];
  for (const [name, job] of jobs) {
    try {
      await job();
    } catch (err) {
      reportError(`cron ${cron}: ${name} failed`, err, { component: "cron", tags: { cron, job: name } });
    }
  }
}
