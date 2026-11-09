/**
 * The intranet's scheduled work (cron). Port of file_expiry.sweep_transfers: expiry of released and
 * undecided transfers, stale invites and abandoned uploads (each writes its decision-log row), blob
 * deletion, and the integrity hash for any file whose upload-time hash did not finish.
 */
import type { Env, Settings } from "../env";
import { getDb } from "../db/client";
import { computeSha256Async } from "../routes/_files";
import * as C from "./constants";
import * as T from "./transfers";
import { retryStuckScans } from "./scan";
import { runPass } from "./reviewAgent";
import { runQueued } from "./benchmark";

export async function backfillSha256(env: Env, limit = 5): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT f.id, f.storage_key FROM file_assets f JOIN transfers t ON t.file_id = f.id
     WHERE f.sha256 IS NULL AND f.status = 'active' AND f.storage_key LIKE '${C.INTRANET_KEY_PREFIX}%' LIMIT ?1`,
  )
    .bind(limit)
    .all<{ id: string; storage_key: string }>();
  const db = getDb(env.DB);
  for (const f of results) await computeSha256Async(env.FILES, db, f.id, f.storage_key);
  return results.length;
}

export async function runIntranetSweep(env: Env, settings: Settings): Promise<void> {
  const keys = await T.sweep(env.DB);
  for (const key of keys) await T.deleteBlob(env.FILES, key);
  const steps: [string, () => Promise<unknown>][] = [
    ["sha256 backfill", () => backfillSha256(env)],
    ["scan retry", () => retryStuckScans(env, settings)],
    ["review agent", async () => {
      const s = await runPass(env, settings);
      if (s.approved || s.escalated) console.log(`review agent: ${s.approved} approved, ${s.escalated} escalated`);
    }],
    ["benchmarks", () => runQueued(env, settings)],
  ];
  for (const [name, step] of steps) {
    try {
      await step();
    } catch (err) {
      console.error(`intranet sweeper: ${name} failed`, err);
    }
  }
}
