/**
 * Port of backend/app/services/file_expiry.py. Called by the 15-minute cron
 * (replaces expiry_sweeper_loop).
 * TODO(port): not yet ported.
 */
import type { Env, Settings } from "../env";
import type { Db } from "../db/client";

export async function sweepExpiredFiles(_env: Env, _settings: Settings, _db: Db): Promise<number> {
  return 0;
}
