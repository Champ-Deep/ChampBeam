/**
 * Transfer lifecycle. Port of backend/app/services/transfer_service.py onto D1.
 *
 * Every state change is one conditional UPDATE (the WHERE clause names the states it may leave), batched
 * with its decision-log rows (decisionLog.commit), so a lost race changes nothing and logs nothing.
 */
import type { Settings } from "../env";
import { hmacSha256Hex, timingSafeEqual, tokenHex } from "../lib/crypto";
import { HTTPError } from "../lib/errors";
import { nowIso } from "../lib/time";
import * as C from "./constants";
import { commit, type AgentFields, type LogInput } from "./decisionLog";

export class TransferError extends HTTPError {
  constructor(message: string, status = 400) {
    super(status, message);
  }
}

export interface TransferRow {
  id: string;
  organization_id: string;
  file_id: string;
  submitter_user_id: string;
  recipient_user_id: string;
  purpose: string;
  state: string;
  requested_expires_in_days: number | null;
  requested_one_time: number;
  one_time: number;
  expires_at: string | null;
  download_claim_token: string | null;
  download_claim_at: string | null;
  check_results: string | null;
  submitted_at: string;
  agent_window_ends_at: string | null;
  hard_expires_at: string | null;
  decided_at: string | null;
  decided_by_type: string | null;
  decided_by_id: string | null;
  reject_reason: string | null;
  released_at: string | null;
  first_opened_at: string | null;
  consumed_at: string | null;
  expired_at: string | null;
  revoked_at: string | null;
  revoked_by_id: string | null;
  withdrawn_at: string | null;
  scan_status: string | null;
  scan_detail: string | null;
  scanned_at: string | null;
  reminded_at: string | null;
  escalated_at: string | null;
  escalation_reason: string | null;
  agent_evaluated_at: string | null;
  agent_result: string | null;
  access_code_hash: string | null;
  access_code_attempts: number;
  access_code_window_at: string | null;
}

export interface ReviewSettings {
  organization_id: string;
  agent_mode: string;
  agent_window_hours: number;
  agent_threshold: number;
  agent_input_mode: string;
  default_expiry_days: number;
  hard_expiry_days: number;
  reminder_hours: number | null;
  updated_at: string | null;
  updated_by_id: string | null;
}

export interface DownloadClaim {
  transferId: string;
  token: string | null;
  oneTime: boolean;
}

const inList = (states: readonly string[]) => states.map((s) => `'${s}'`).join(", ");
const addDays = (iso: string, days: number) => new Date(Date.parse(iso) + days * 86_400_000).toISOString();

export async function getTransfer(d1: D1Database, id: string): Promise<TransferRow | null> {
  return d1.prepare("SELECT * FROM transfers WHERE id = ?1").bind(id).first<TransferRow>();
}

export async function getReviewSettings(d1: D1Database, organizationId: string): Promise<ReviewSettings> {
  await d1
    .prepare("INSERT INTO org_review_settings (organization_id, updated_at) VALUES (?1, ?2) ON CONFLICT(organization_id) DO NOTHING")
    .bind(organizationId, nowIso())
    .run();
  return (await d1.prepare("SELECT * FROM org_review_settings WHERE organization_id = ?1").bind(organizationId).first<ReviewSettings>())!;
}

/** Largest file this deployment accepts: the org cap, and the Worker body limit when uploads stream through it. */
export function effectiveMaxFileBytes(settings: Settings): number {
  return settings.r2PresignConfigured ? settings.intranetMaxFileBytes : Math.min(settings.intranetMaxFileBytes, settings.workerUploadMaxBytes);
}

/** SUB-5 hard checks run before a file can enter the queue (size, type). */
export function hardCheckFailures(settings: Settings, filename: string, sizeBytes: number): string[] {
  const failures: string[] = [];
  if (sizeBytes <= 0) failures.push("File is empty.");
  const cap = effectiveMaxFileBytes(settings);
  if (sizeBytes > cap) failures.push(`File exceeds the ${Math.floor(cap / (1024 * 1024))} MB limit.`);
  const name = filename.toLowerCase().replace(/[. ]+$/, "");
  const parts = name.split(".").slice(1);
  const hits = [...new Set(parts.filter((p) => settings.intranetBlockedExtensionSet.has(p)))].sort();
  if (hits.length) failures.push(`Blocked file type: .${hits.join(", .")}`);
  return failures;
}

export function effectiveRequestedDays(t: TransferRow, review: ReviewSettings): number {
  return t.requested_expires_in_days || review.default_expiry_days;
}

/** Soft-delete the transfer's file row; returns the storage key so the caller can delete the blob. */
export async function markFileDeleted(d1: D1Database, fileId: string): Promise<string | null> {
  const row = await d1
    .prepare("UPDATE file_assets SET status = 'deleted' WHERE id = ?1 AND status != 'deleted' RETURNING storage_key")
    .bind(fileId)
    .first<{ storage_key: string }>();
  return row?.storage_key ?? null;
}

export async function deleteBlob(bucket: R2Bucket, key: string | null): Promise<void> {
  if (!key) return;
  try {
    await bucket.delete(key);
  } catch (err) {
    console.error(`intranet: blob delete failed for key=${key}`, err);
  }
}

/** Run a guarded transition with its log rows; 409 when the transfer already left `from`. */
async function transition(
  d1: D1Database,
  t: TransferRow,
  from: readonly string[],
  set: Record<string, unknown>,
  logs: LogInput[],
  extraWhere = "",
): Promise<TransferRow> {
  const cols = Object.keys(set);
  const sql = `UPDATE transfers SET ${cols.map((c, i) => `${c} = ?${i + 2}`).join(", ")} WHERE id = ?1 AND state IN (${inList(from)})${extraWhere}`;
  const guard = d1.prepare(sql).bind(t.id, ...cols.map((c) => set[c] as unknown));
  const ok = await commit(d1, { guard, logs });
  const fresh = (await getTransfer(d1, t.id))!;
  if (!ok) throw new TransferError(`Transfer is ${fresh.state}; this action is no longer possible.`, 409);
  return fresh;
}

export async function openForReview(d1: D1Database, t: TransferRow, reviewerId: string): Promise<TransferRow> {
  const log: LogInput = { organizationId: t.organization_id, transferId: t.id, event: C.EVENT_OPENED_FOR_REVIEW, actorType: C.ACTOR_HUMAN, actorId: reviewerId };
  if (t.state === C.STATE_SUBMITTED) {
    try {
      return await transition(d1, t, [C.STATE_SUBMITTED], { state: C.STATE_IN_REVIEW }, [log]);
    } catch (err) {
      if (!(err instanceof TransferError)) throw err;
    }
  }
  await commit(d1, { logs: [log] });
  return (await getTransfer(d1, t.id))!;
}

export async function hashTransferCode(settings: Settings, transferId: string, code: string): Promise<string> {
  if (!settings.resolvedUploadSecret) throw new TransferError("Access codes are not configured on this server.", 503);
  return hmacSha256Hex(settings.resolvedUploadSecret, `${transferId}:${code}`);
}

export async function approve(
  d1: D1Database,
  settings: Settings,
  t: TransferRow,
  reviewerId: string,
  review: ReviewSettings,
  opts: {
    expiresInDays?: number | null;
    oneTime?: boolean | null;
    reason?: string | null;
    actorType?: string;
    agent?: AgentFields | null;
    accessCode?: string | null;
    agentResult?: unknown;
  } = {},
): Promise<TransferRow> {
  if (t.submitter_user_id === reviewerId) throw new TransferError("You cannot decide your own submission.", 403);
  const allowed = effectiveRequestedDays(t, review);
  const days = opts.expiresInDays == null ? allowed : opts.expiresInDays;
  if (days > allowed) throw new TransferError(`Expiry can only be tightened: the requested limit is ${allowed} days.`, 422);
  if (t.requested_one_time && opts.oneTime === false) throw new TransferError("One-time access was requested and cannot be loosened.", 422);
  const finalOneTime = !!(t.requested_one_time || opts.oneTime);
  const code = (opts.accessCode ?? "").trim();
  if (code && !/^\d{4,8}$/.test(code)) throw new TransferError("The access code must be 4 to 8 digits.", 422);
  const actorType = opts.actorType ?? C.ACTOR_HUMAN;
  const now = nowIso();
  const limits: Record<string, unknown> = { expires_in_days: days, one_time: finalOneTime };
  if (code) limits.access_code = true;
  const set: Record<string, unknown> = {
    state: C.STATE_RELEASED,
    decided_at: now,
    decided_by_type: actorType,
    decided_by_id: reviewerId,
    released_at: now,
    expires_at: addDays(now, days),
    one_time: finalOneTime ? 1 : 0,
    access_code_hash: code ? await hashTransferCode(settings, t.id, code) : null,
    access_code_attempts: 0,
    access_code_window_at: null,
  };
  if (opts.agentResult !== undefined) {
    set.agent_evaluated_at = now;
    set.agent_result = JSON.stringify(opts.agentResult);
  }
  return transition(d1, t, C.PENDING_STATES, set, [
    { organizationId: t.organization_id, transferId: t.id, event: C.EVENT_APPROVED, actorType, actorId: reviewerId, reason: opts.reason ?? null, detail: limits, agent: opts.agent ?? null },
    { organizationId: t.organization_id, transferId: t.id, event: C.EVENT_RELEASED, actorType, actorId: reviewerId, detail: limits },
  ]);
}

export async function reject(d1: D1Database, t: TransferRow, reviewerId: string, reason: string): Promise<{ transfer: TransferRow; key: string | null }> {
  if (t.submitter_user_id === reviewerId) throw new TransferError("You cannot decide your own submission.", 403);
  const r = (reason ?? "").trim();
  if (!r) throw new TransferError("A reason is required to reject.", 422);
  const now = nowIso();
  const transfer = await transition(
    d1,
    t,
    C.PENDING_STATES,
    { state: C.STATE_REJECTED, decided_at: now, decided_by_type: C.ACTOR_HUMAN, decided_by_id: reviewerId, reject_reason: r },
    [{ organizationId: t.organization_id, transferId: t.id, event: C.EVENT_REJECTED, actorType: C.ACTOR_HUMAN, actorId: reviewerId, reason: r }],
  );
  return { transfer, key: await markFileDeleted(d1, t.file_id) };
}

export async function revoke(d1: D1Database, t: TransferRow, actorId: string, reason: string | null): Promise<{ transfer: TransferRow; key: string | null }> {
  const transfer = await transition(
    d1,
    t,
    C.REVOCABLE_STATES,
    { state: C.STATE_REVOKED, revoked_at: nowIso(), revoked_by_id: actorId },
    [{ organizationId: t.organization_id, transferId: t.id, event: C.EVENT_REVOKED, actorType: C.ACTOR_HUMAN, actorId, reason }],
  );
  return { transfer, key: await markFileDeleted(d1, t.file_id) };
}

/** SUB-6: the submitter withdraws an unreleased submission. */
export async function withdraw(d1: D1Database, t: TransferRow, actorId: string, reason: string | null): Promise<{ transfer: TransferRow; key: string | null }> {
  if (t.submitter_user_id !== actorId) throw new TransferError("Only the submitter can withdraw a submission.", 403);
  const transfer = await transition(
    d1,
    t,
    C.WITHDRAWABLE_STATES,
    { state: C.STATE_WITHDRAWN, withdrawn_at: nowIso() },
    [{ organizationId: t.organization_id, transferId: t.id, event: C.EVENT_WITHDRAWN, actorType: C.ACTOR_HUMAN, actorId, reason }],
  );
  return { transfer, key: await markFileDeleted(d1, t.file_id) };
}

/** AGT-8: a Reviewer overturns an agent approval until the recipient has opened (or started to open) the file. */
export async function overturn(d1: D1Database, t: TransferRow, reviewerId: string, reason: string): Promise<{ transfer: TransferRow; key: string | null }> {
  const r = (reason ?? "").trim();
  if (!r) throw new TransferError("A reason is required to overturn.", 422);
  if (t.decided_by_type !== C.ACTOR_AGENT) throw new TransferError("Only agent approvals can be overturned.", 409);
  if (t.submitter_user_id === reviewerId) throw new TransferError("You cannot decide your own submission.", 403);
  const guard = d1
    .prepare(
      `UPDATE transfers SET state = '${C.STATE_REJECTED}', decided_at = ?2, decided_by_type = '${C.ACTOR_HUMAN}', decided_by_id = ?3, reject_reason = ?4
       WHERE id = ?1 AND state = '${C.STATE_RELEASED}' AND decided_by_type = '${C.ACTOR_AGENT}' AND first_opened_at IS NULL AND download_claim_token IS NULL`,
    )
    .bind(t.id, nowIso(), reviewerId, r);
  const ok = await commit(d1, {
    guard,
    logs: [{ organizationId: t.organization_id, transferId: t.id, event: C.EVENT_OVERTURNED, actorType: C.ACTOR_HUMAN, actorId: reviewerId, reason: r }],
  });
  if (!ok) throw new TransferError("The recipient has already opened this file, so it cannot be overturned.", 409);
  return { transfer: (await getTransfer(d1, t.id))!, key: await markFileDeleted(d1, t.file_id) };
}

// ---------------------------------------------------------------------------
// Access code on release (REL-7, P2). Attempts are counted on the transfer row (5 per file per 10 minutes),
// so the limit holds without Redis and per file rather than per IP.
// ---------------------------------------------------------------------------

export const CODE_ATTEMPTS_PER_WINDOW = 5;
export const CODE_WINDOW_SECONDS = 600;

export async function checkAccessCode(d1: D1Database, settings: Settings, t: TransferRow, userId: string, code: string | null): Promise<void> {
  if (!t.access_code_hash) return;
  const c = (code ?? "").trim();
  if (!c) throw new TransferError("This file needs the access code the Reviewer gave you.", 403);
  const now = nowIso();
  const windowStart = new Date(Date.now() - CODE_WINDOW_SECONDS * 1000).toISOString();
  // Count the attempt atomically; a fresh window restarts at 1.
  const res = await d1
    .prepare(
      `UPDATE transfers SET
         access_code_attempts = CASE WHEN access_code_window_at IS NULL OR access_code_window_at <= ?2 THEN 1 ELSE access_code_attempts + 1 END,
         access_code_window_at = CASE WHEN access_code_window_at IS NULL OR access_code_window_at <= ?2 THEN ?3 ELSE access_code_window_at END
       WHERE id = ?1 AND (access_code_window_at IS NULL OR access_code_window_at <= ?2 OR access_code_attempts < ?4)`,
    )
    .bind(t.id, windowStart, now, CODE_ATTEMPTS_PER_WINDOW)
    .run();
  if ((res.meta.changes ?? 0) !== 1) {
    throw new TransferError(`Too many wrong access codes. Try again in ${CODE_WINDOW_SECONDS / 60} minutes.`, 429);
  }
  const ok = /^\d{4,8}$/.test(c) && timingSafeEqual(await hashTransferCode(settings, t.id, c), t.access_code_hash);
  if (ok) {
    await d1.prepare("UPDATE transfers SET access_code_attempts = 0, access_code_window_at = NULL WHERE id = ?1").bind(t.id).run();
    return;
  }
  await commit(d1, { logs: [{ organizationId: t.organization_id, transferId: t.id, event: C.EVENT_ACCESS_CODE_FAILED, actorType: C.ACTOR_HUMAN, actorId: userId }] });
  throw new TransferError("That access code is wrong.", 403);
}

// ---------------------------------------------------------------------------
// Downloads (REL-2, REL-4): one-time files are claimed atomically, consumed when the stream ends.
// ---------------------------------------------------------------------------

const liveRelease = (now: string) =>
  `state = '${C.STATE_RELEASED}' AND revoked_at IS NULL AND consumed_at IS NULL AND (expires_at IS NULL OR expires_at > '${now}')`;

async function classifyRefusal(d1: D1Database, id: string, now: string): Promise<TransferError> {
  const row = await getTransfer(d1, id);
  if (!row) return new TransferError("File not found.", 404);
  if (row.state === C.STATE_REVOKED || row.revoked_at) return new TransferError("This file was revoked.", 410);
  if (row.state === C.STATE_CONSUMED || row.consumed_at) return new TransferError("This one-time file has already been downloaded.", 410);
  if (row.state === C.STATE_EXPIRED || (row.expires_at && row.expires_at <= now)) return new TransferError("This file has expired.", 410);
  if (row.state === C.STATE_RELEASED && row.one_time) return new TransferError("This one-time file is being downloaded in another session.", 409);
  return new TransferError("This file has not been released.", 403);
}

export async function claimDownload(d1: D1Database, settings: Settings, t: TransferRow, recipientId: string): Promise<DownloadClaim> {
  const now = nowIso();
  if (t.recipient_user_id !== recipientId) throw new TransferError("File not found.", 404);
  if (!t.one_time) {
    const ok = await d1.prepare(`SELECT id FROM transfers WHERE id = ?1 AND ${liveRelease(now)}`).bind(t.id).first();
    if (!ok) throw await classifyRefusal(d1, t.id, now);
    return { transferId: t.id, token: null, oneTime: false };
  }
  const token = tokenHex(16);
  const stale = new Date(Date.now() - settings.intranetDownloadLeaseSeconds * 1000).toISOString();
  const res = await d1
    .prepare(
      `UPDATE transfers SET download_claim_token = ?2, download_claim_at = ?3
       WHERE id = ?1 AND recipient_user_id = ?4 AND ${liveRelease(now)}
         AND (download_claim_at IS NULL OR download_claim_at < ?5)`,
    )
    .bind(t.id, token, now, recipientId, stale)
    .run();
  if ((res.meta.changes ?? 0) !== 1) throw await classifyRefusal(d1, t.id, now);
  return { transferId: t.id, token, oneTime: true };
}

export async function heartbeatClaim(d1: D1Database, claim: DownloadClaim): Promise<boolean> {
  if (!claim.oneTime) return true;
  const res = await d1
    .prepare(
      `UPDATE transfers SET download_claim_at = ?3 WHERE id = ?1 AND download_claim_token = ?2 AND state = '${C.STATE_RELEASED}' AND revoked_at IS NULL`,
    )
    .bind(claim.transferId, claim.token, nowIso())
    .run();
  return (res.meta.changes ?? 0) === 1;
}

export async function releaseClaim(d1: D1Database, claim: DownloadClaim): Promise<void> {
  if (!claim.oneTime) return;
  await d1
    .prepare("UPDATE transfers SET download_claim_token = NULL, download_claim_at = NULL WHERE id = ?1 AND download_claim_token = ?2")
    .bind(claim.transferId, claim.token)
    .run();
}

/** The stream finished: record the open (REL-6) and, for one-time files, consume and return the blob key. */
export async function completeDownload(d1: D1Database, claim: DownloadClaim, recipientId: string): Promise<string | null> {
  const t = await getTransfer(d1, claim.transferId);
  if (!t) return null;
  const now = nowIso();
  const opened: LogInput = { organizationId: t.organization_id, transferId: t.id, event: C.EVENT_OPENED_BY_RECIPIENT, actorType: C.ACTOR_HUMAN, actorId: recipientId };
  if (claim.oneTime) {
    const guard = d1
      .prepare(
        `UPDATE transfers SET state = '${C.STATE_CONSUMED}', consumed_at = ?3, first_opened_at = COALESCE(first_opened_at, ?3),
           download_claim_token = NULL, download_claim_at = NULL
         WHERE id = ?1 AND download_claim_token = ?2 AND state = '${C.STATE_RELEASED}'`,
      )
      .bind(t.id, claim.token, now);
    const ok = await commit(d1, {
      guard,
      logs: [opened, { organizationId: t.organization_id, transferId: t.id, event: C.EVENT_CONSUMED, actorType: C.ACTOR_HUMAN, actorId: recipientId }],
    });
    return ok ? markFileDeleted(d1, t.file_id) : null;
  }
  // Repeat opens of a multi-use file are logged too; first_opened_at keeps the first.
  const guard = d1.prepare("UPDATE transfers SET first_opened_at = COALESCE(first_opened_at, ?2) WHERE id = ?1").bind(t.id, now);
  await commit(d1, { guard, logs: [opened] });
  return null;
}

// ---------------------------------------------------------------------------
// Sweeper (cron): expiry of released and undecided transfers, stale invites, abandoned uploads.
// ---------------------------------------------------------------------------

export async function sweep(d1: D1Database, limit = 200): Promise<string[]> {
  const now = nowIso();
  const keys: string[] = [];
  const { results: due } = await d1
    .prepare(
      `SELECT * FROM transfers WHERE (state = '${C.STATE_RELEASED}' AND expires_at IS NOT NULL AND expires_at <= ?1)
          OR (state IN (${inList([C.STATE_SCANNING, ...C.PENDING_STATES])}) AND hard_expires_at IS NOT NULL AND hard_expires_at <= ?1)
       LIMIT ?2`,
    )
    .bind(now, limit)
    .all<TransferRow>();
  for (const t of due) {
    const reason = t.state === C.STATE_RELEASED ? "Access window ended." : "No decision before the hard expiry.";
    const guard = d1.prepare("UPDATE transfers SET state = ?3, expired_at = ?4 WHERE id = ?1 AND state = ?2").bind(t.id, t.state, C.STATE_EXPIRED, now);
    const ok = await commit(d1, {
      guard,
      logs: [{ organizationId: t.organization_id, transferId: t.id, event: C.EVENT_EXPIRED, actorType: C.ACTOR_SYSTEM, actorId: C.SWEEPER_ACTOR, reason }],
    });
    if (!ok) continue;
    const key = await markFileDeleted(d1, t.file_id);
    if (key) keys.push(key);
  }

  // Invites past their expiry that nobody accepted.
  const { results: invites } = await d1
    .prepare("SELECT id, organization_id FROM org_invites WHERE revoked_at IS NULL AND accepted_at IS NULL AND expires_at <= ?1 LIMIT ?2")
    .bind(now, limit)
    .all<{ id: string; organization_id: string }>();
  for (const inv of invites) {
    const guard = d1.prepare("UPDATE org_invites SET revoked_at = ?2 WHERE id = ?1 AND revoked_at IS NULL AND accepted_at IS NULL").bind(inv.id, now);
    await commit(d1, {
      guard,
      logs: [{ organizationId: inv.organization_id, event: C.EVENT_INVITE_EXPIRED, actorType: C.ACTOR_SYSTEM, actorId: C.SWEEPER_ACTOR, detail: { invite_id: inv.id } }],
    });
  }

  // REV-6: one in-platform reminder per submission that waited longer than the org's reminder_hours.
  const { results: waiting } = await d1
    .prepare(
      `SELECT t.id, t.organization_id, t.submitted_at, s.reminder_hours FROM transfers t JOIN org_review_settings s ON s.organization_id = t.organization_id
       WHERE t.state IN ('${C.STATE_SUBMITTED}', '${C.STATE_IN_REVIEW}') AND t.reminded_at IS NULL AND s.reminder_hours IS NOT NULL
       ORDER BY t.submitted_at ASC LIMIT ?1`,
    )
    .bind(limit)
    .all<{ id: string; organization_id: string; submitted_at: string; reminder_hours: number }>();
  for (const w of waiting) {
    if (Date.parse(w.submitted_at) > Date.now() - w.reminder_hours * 3_600_000) continue;
    const guard = d1.prepare("UPDATE transfers SET reminded_at = ?2 WHERE id = ?1 AND reminded_at IS NULL").bind(w.id, now);
    await commit(d1, {
      guard,
      logs: [{ organizationId: w.organization_id, transferId: w.id, event: C.EVENT_REMINDER_SENT, actorType: C.ACTOR_SYSTEM, actorId: C.SWEEPER_ACTOR, reason: `Waiting for review longer than ${w.reminder_hours} hours.` }],
    });
  }

  // Uploads that never became a transfer.
  const abandonedBefore = new Date(Date.now() - C.ABANDONED_UPLOAD_SECONDS * 1000).toISOString();
  const { results: abandoned } = await d1
    .prepare(
      `UPDATE file_assets SET status = 'deleted'
       WHERE id IN (SELECT f.id FROM file_assets f LEFT JOIN transfers t ON t.file_id = f.id
                    WHERE t.id IS NULL AND f.status != 'deleted' AND f.created_at < ?1 AND f.storage_key LIKE '${C.INTRANET_KEY_PREFIX}%' LIMIT ?2)
       RETURNING storage_key`,
    )
    .bind(abandonedBefore, limit)
    .all<{ storage_key: string }>();
  for (const a of abandoned) keys.push(a.storage_key);
  return keys;
}

export { timingSafeEqual };
