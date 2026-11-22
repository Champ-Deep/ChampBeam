/**
 * Malware scan (SUB-5, P1). Port of backend/app/services/malware_scan.py: the file is streamed from R2 to
 * clamd with INSTREAM over a Worker TCP socket (cloudflare:sockets). CLAMD_HOST must be reachable from
 * Cloudflare (a public host, or a Cloudflare Tunnel hostname). Unset = every file is "not_scanned".
 *
 * Verdicts: clean -> the file enters the queue; infected -> refused, blob deleted, logged as check_failed;
 * anything else (unreachable, timeout, over the stream limit) -> queued, flagged "not scanned", and the
 * review agent will never approve it (AGT-3).
 */
import { connect } from "cloudflare:sockets";
import type { Env, Settings } from "../env";
import { nowIso } from "../lib/time";
import * as C from "./constants";
import { commit } from "./decisionLog";
import * as T from "./transfers";
import { reportError } from "../lib/observability";

export interface ScanResult {
  status: string;
  detail: string | null;
}

const CHUNK = 64 * 1024;

export function parseReply(reply: string): ScanResult {
  const text = reply.replace(/\0+$/g, "").trim();
  if (text.endsWith("OK")) return { status: C.SCAN_CLEAN, detail: "clamd: OK" };
  if (text.endsWith("FOUND")) {
    const body = text.includes(":") ? text.slice(text.indexOf(":") + 1) : text;
    const signature = body.replace(/ FOUND$/, "").trim();
    return { status: C.SCAN_INFECTED, detail: `clamd: ${signature}` };
  }
  if (/size limit exceeded/i.test(text)) return { status: C.SCAN_NOT_SCANNED, detail: "File is larger than the scanner's stream limit." };
  return { status: C.SCAN_NOT_SCANNED, detail: `Scanner error: ${text.slice(0, 200) || "empty reply"}` };
}

async function instream(settings: Settings, body: ReadableStream<Uint8Array>): Promise<string> {
  const socket = connect({ hostname: settings.clamdHost, port: settings.clamdPort });
  const writer = socket.writable.getWriter();
  try {
    await writer.write(new TextEncoder().encode("zINSTREAM\0"));
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (let i = 0; i < value.length; i += CHUNK) {
        const part = value.subarray(i, i + CHUNK);
        const frame = new Uint8Array(4 + part.length);
        new DataView(frame.buffer).setUint32(0, part.length);
        frame.set(part, 4);
        await writer.write(frame);
      }
    }
    await writer.write(new Uint8Array(4));
    const r = socket.readable.getReader();
    const { value } = await r.read();
    return new TextDecoder().decode(value ?? new Uint8Array());
  } finally {
    try {
      await socket.close();
    } catch {
      /* already closed */
    }
  }
}

export async function scanObject(env: Env, settings: Settings, key: string, sizeBytes: number): Promise<ScanResult> {
  if (!settings.clamdConfigured) return { status: C.SCAN_NOT_SCANNED, detail: "Malware scanning is not configured." };
  if (sizeBytes > settings.clamdMaxStreamBytes) {
    return { status: C.SCAN_NOT_SCANNED, detail: `File is larger than the ${Math.floor(settings.clamdMaxStreamBytes / (1024 * 1024))} MB scan limit.` };
  }
  const obj = await env.FILES.get(key);
  if (!obj) return { status: C.SCAN_NOT_SCANNED, detail: "Could not read the file for scanning." };
  try {
    const reply = await Promise.race([
      instream(settings, obj.body),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), settings.clamdTimeoutS * 1000)),
    ]);
    return parseReply(reply);
  } catch (err) {
    if ((err as Error).message === "timeout") return { status: C.SCAN_NOT_SCANNED, detail: "Scanner timed out." };
    reportError("clamd unreachable", err, { component: "intranet.scan", level: "warning" });
    return { status: C.SCAN_NOT_SCANNED, detail: "Scanner unreachable." };
  }
}

/** Record a verdict on a transfer still in `scanning`. Returns the blob key to delete when infected. */
export async function applyScanResult(d1: D1Database, transferId: string, result: ScanResult): Promise<string | null> {
  const t = await T.getTransfer(d1, transferId);
  if (!t || t.state !== C.STATE_SCANNING) return null;
  const checks = { ...(t.check_results ? JSON.parse(t.check_results) : {}), malware_scan: result.status };
  const infected = result.status === C.SCAN_INFECTED;
  const guard = d1
    .prepare(
      `UPDATE transfers SET state = ?2, scan_status = ?3, scan_detail = ?4, scanned_at = ?5, check_results = ?6
       WHERE id = ?1 AND state = '${C.STATE_SCANNING}'`,
    )
    .bind(t.id, infected ? C.STATE_CHECK_FAILED : C.STATE_SUBMITTED, result.status, result.detail, nowIso(), JSON.stringify(checks));
  const logs = [{ organizationId: t.organization_id, transferId: t.id, event: C.EVENT_SCANNED, actorType: C.ACTOR_SYSTEM, actorId: "scanner", detail: { status: result.status } }];
  if (infected) {
    logs.push({
      organizationId: t.organization_id,
      transferId: t.id,
      event: C.EVENT_CHECK_FAILED,
      actorType: C.ACTOR_SYSTEM,
      actorId: "scanner",
      reason: `Malware detected (${result.detail ?? "unknown signature"}).`,
    } as never);
  }
  const ok = await commit(d1, { guard, logs });
  return ok && infected ? T.markFileDeleted(d1, t.file_id) : null;
}

export async function scanTransfer(env: Env, settings: Settings, transferId: string, scanner = scanObject): Promise<void> {
  const t = await T.getTransfer(env.DB, transferId);
  if (!t || t.state !== C.STATE_SCANNING) return;
  const f = await env.DB.prepare("SELECT storage_key, size_bytes FROM file_assets WHERE id = ?1").bind(t.file_id).first<{ storage_key: string; size_bytes: number }>();
  if (!f) return;
  const result = await scanner(env, settings, f.storage_key, f.size_bytes);
  await T.deleteBlob(env.FILES, await applyScanResult(env.DB, transferId, result));
}

/** Scans left in `scanning` (the Worker was evicted mid-scan) are retried by the sweeper. */
export async function retryStuckScans(env: Env, settings: Settings, limit = 20): Promise<number> {
  const cutoff = new Date(Date.now() - settings.intranetScanRetrySeconds * 1000).toISOString();
  const { results } = await env.DB.prepare(`SELECT id FROM transfers WHERE state = '${C.STATE_SCANNING}' AND submitted_at < ?1 LIMIT ?2`)
    .bind(cutoff, limit)
    .all<{ id: string }>();
  for (const r of results) await scanTransfer(env, settings, r.id);
  return results.length;
}
