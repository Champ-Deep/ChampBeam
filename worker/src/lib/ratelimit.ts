/**
 * Fixed-window counters on D1 — the replacement for `redis_client.incr_with_ttl`.
 *
 * Same contract as the Python helper: returns the post-increment count, or
 * null when storage is unavailable (callers treat null as "no limit
 * enforced", i.e. fail open). Expired rows are deleted by the cron sweep.
 */
import { HTTPError } from "./errors";

export async function incrWithTtl(db: D1Database, key: string, ttlSeconds: number): Promise<number | null> {
  const now = Math.floor(Date.now() / 1000);
  try {
    const row = await db
      .prepare(
        `INSERT INTO rate_counters (key, count, expires_at) VALUES (?1, 1, ?2)
         ON CONFLICT(key) DO UPDATE SET
           count = CASE WHEN rate_counters.expires_at <= ?3 THEN 1 ELSE rate_counters.count + 1 END,
           expires_at = CASE WHEN rate_counters.expires_at <= ?3 THEN excluded.expires_at ELSE rate_counters.expires_at END
         RETURNING count`,
      )
      .bind(key, now + ttlSeconds, now)
      .first<{ count: number }>();
    return row?.count ?? null;
  } catch (err) {
    console.warn("rate counter unavailable, failing open", err);
    return null;
  }
}

/** Current fixed window index for a window length (int(time.time() // window)). */
export function windowIndex(windowSeconds: number): number {
  return Math.floor(Date.now() / 1000 / windowSeconds);
}

/** Throw 429 with `detail` when `key` exceeds `limit` within its window. */
export async function enforceLimit(
  db: D1Database,
  key: string,
  limit: number,
  windowSeconds: number,
  detail: string,
): Promise<void> {
  const count = await incrWithTtl(db, `${key}:${windowIndex(windowSeconds)}`, windowSeconds);
  if (count !== null && count > limit) throw new HTTPError(429, detail);
}

export async function purgeExpiredCounters(db: D1Database): Promise<void> {
  await db
    .prepare("DELETE FROM rate_counters WHERE expires_at <= ?1")
    .bind(Math.floor(Date.now() / 1000))
    .run();
}
