/**
 * Expiry for anonymous (auto-expiring) file assets. Port of
 * backend/app/services/file_expiry.py.
 *
 * Two layers: lazy expiry at serve time (`expireAsset`, run in the background
 * from the serve router when an expired file is requested) and the periodic
 * sweep, now driven by the 15-minute cron (`sweepExpiredFiles`, replacing
 * `expiry_sweeper_loop`) that reclaims expired blobs + rows even if nobody
 * visits them again.
 *
 * Exports:
 *   expireAsset(bucket: R2Bucket, db, fileId): Promise<void>
 *   sweepExpired(bucket: R2Bucket, db, limit = 200): Promise<number>
 *   sweepExpiredFiles(env, settings, db): Promise<number>      (cron entry point)
 */
import { and, eq, inArray, isNotNull, lt, ne } from "drizzle-orm";
import type { Env, Settings } from "../env";
import type { Db } from "../db/client";
import { FILE_STATUS_DELETED, fileAssets } from "../db/schema";
import { deleteObject } from "../lib/storage";
import { nowIso } from "../lib/time";

async function deleteBlob(bucket: R2Bucket, storageKey: string): Promise<void> {
  try {
    await deleteObject(bucket, storageKey);
  } catch (err) {
    console.error(`file expiry: blob delete failed for key=${storageKey}`, err);
  }
}

/** Soft-delete one asset and best-effort remove its blob. */
export async function expireAsset(bucket: R2Bucket, db: Db, fileId: string): Promise<void> {
  // Conditional update: only the caller that flips the status deletes the blob.
  const rows = await db
    .update(fileAssets)
    .set({ status: FILE_STATUS_DELETED })
    .where(and(eq(fileAssets.id, fileId), ne(fileAssets.status, FILE_STATUS_DELETED)))
    .returning({ storageKey: fileAssets.storageKey });
  if (!rows.length) return;
  await deleteBlob(bucket, rows[0].storageKey);
}

/** Delete a batch of expired files. Returns the number swept. */
export async function sweepExpired(bucket: R2Bucket, db: Db, limit = 200): Promise<number> {
  const due = db
    .select({ id: fileAssets.id })
    .from(fileAssets)
    .where(
      and(isNotNull(fileAssets.expiresAt), lt(fileAssets.expiresAt, nowIso()), ne(fileAssets.status, FILE_STATUS_DELETED)),
    )
    .limit(limit);
  // One statement selects + flips the batch, so concurrent sweeps never double-delete.
  const rows = await db
    .update(fileAssets)
    .set({ status: FILE_STATUS_DELETED })
    .where(and(inArray(fileAssets.id, due), ne(fileAssets.status, FILE_STATUS_DELETED)))
    .returning({ storageKey: fileAssets.storageKey });
  for (const { storageKey } of rows) await deleteBlob(bucket, storageKey);
  return rows.length;
}

/** Cron entry: a few batches per run (the Python loop swept one batch per interval). */
const MAX_BATCHES_PER_RUN = 5;

export async function sweepExpiredFiles(env: Env, _settings: Settings, db: Db): Promise<number> {
  let total = 0;
  for (let i = 0; i < MAX_BATCHES_PER_RUN; i++) {
    const swept = await sweepExpired(env.FILES, db);
    total += swept;
    if (swept < 200) break;
  }
  if (total) console.log(`file expiry sweeper reclaimed ${total} file(s)`);
  return total;
}
