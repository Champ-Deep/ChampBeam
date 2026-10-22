/**
 * Port of backend/app/services/domain_provisioning.py. `refreshPendingDomains`
 * is called by the 5-minute cron (replaces domain_provision_loop).
 * TODO(port): not yet ported.
 */
import type { Env, Settings } from "../env";
import type { Db } from "../db/client";

export async function refreshPendingDomains(_env: Env, _settings: Settings, _db: Db): Promise<void> {}
