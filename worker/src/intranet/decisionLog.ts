/**
 * Append-only, hash-chained decision log (BRD 7.1). Port of backend/app/services/decision_log.py.
 *
 * Each row's row_hash = sha256(prev_hash + canonical JSON of the row), so editing or deleting a row
 * breaks the chain at that row (verifyChain). The database also refuses UPDATE and DELETE (triggers in
 * migrations/0009_intranet.sql), and no API route writes anything but INSERTs here.
 *
 * D1 has no interactive transactions, so a state change and its log rows are written in ONE batch
 * (D1 batches are atomic): the guard statement (a conditional UPDATE or an INSERT) comes first and each
 * log INSERT only fires `WHERE changes() > 0`, i.e. when the statement before it wrote a row. A guard that
 * matched nothing therefore writes no log rows, and a log write that fails rolls the guard back.
 * Two writers reading the same chain tip collide on the unique (org, prev_hash) index; the loser's whole
 * batch rolls back and is retried on the new tip.
 */
import { ACTOR_HUMAN } from "./constants";

export interface AgentFields {
  provider?: string | null;
  model?: string | null;
  input_mode?: string | null;
  p_approve?: number | null;
  threshold?: number | null;
  input_sha256?: string | null;
}

export interface LogInput {
  organizationId: string;
  event: string;
  actorType?: string;
  actorId?: string | null;
  transferId?: string | null;
  reason?: string | null;
  detail?: Record<string, unknown> | null;
  agent?: AgentFields | null;
}

export interface LogRow {
  id: number;
  at: string;
  organization_id: string;
  transfer_id: string | null;
  event: string;
  actor_type: string;
  actor_id: string | null;
  reason: string | null;
  detail: string | null;
  agent_provider: string | null;
  agent_model: string | null;
  agent_input_mode: string | null;
  agent_p_approve: number | null;
  agent_threshold: number | null;
  agent_input_sha256: string | null;
  prev_hash: string | null;
  row_hash: string;
}

type HashedFields = Omit<LogRow, "id" | "prev_hash" | "row_hash" | "detail"> & { detail: unknown };

/** JSON with object keys sorted at every level (Python json.dumps(sort_keys=True), compact separators). */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256HexStr(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function computeHash(prevHash: string | null, fields: HashedFields): Promise<string> {
  const body = {
    at: fields.at,
    organization_id: fields.organization_id,
    transfer_id: fields.transfer_id,
    event: fields.event,
    actor_type: fields.actor_type,
    actor_id: fields.actor_id,
    reason: fields.reason,
    detail: fields.detail ?? null,
    agent_provider: fields.agent_provider,
    agent_model: fields.agent_model,
    agent_input_mode: fields.agent_input_mode,
    agent_p_approve: fields.agent_p_approve,
    agent_threshold: fields.agent_threshold,
    agent_input_sha256: fields.agent_input_sha256,
  };
  return sha256HexStr((prevHash ?? "") + canonicalJson(body));
}

/** Second-precision UTC timestamp for log rows. */
export function logNow(): string {
  const d = new Date();
  d.setUTCMilliseconds(0);
  return d.toISOString();
}

function fieldsOf(input: LogInput, at: string): HashedFields {
  const a = input.agent ?? {};
  return {
    at,
    organization_id: input.organizationId,
    transfer_id: input.transferId ?? null,
    event: input.event,
    actor_type: input.actorType ?? ACTOR_HUMAN,
    actor_id: input.actorId ?? null,
    reason: input.reason ?? null,
    detail: input.detail ?? null,
    agent_provider: a.provider ?? null,
    agent_model: a.model ?? null,
    agent_input_mode: a.input_mode ?? null,
    agent_p_approve: a.p_approve ?? null,
    agent_threshold: a.threshold ?? null,
    agent_input_sha256: a.input_sha256 ?? null,
  };
}

const INSERT_COLS =
  "at, organization_id, transfer_id, event, actor_type, actor_id, reason, detail, agent_provider, agent_model, " +
  "agent_input_mode, agent_p_approve, agent_threshold, agent_input_sha256, prev_hash, row_hash";

async function insertStatements(d1: D1Database, logs: LogInput[], conditional: boolean): Promise<D1PreparedStatement[]> {
  if (!logs.length) return [];
  const orgs = new Set(logs.map((l) => l.organizationId));
  const tips = new Map<string, string | null>();
  for (const org of orgs) {
    const row = await d1
      .prepare("SELECT row_hash FROM decision_log WHERE organization_id = ?1 ORDER BY id DESC LIMIT 1")
      .bind(org)
      .first<{ row_hash: string }>();
    tips.set(org, row?.row_hash ?? null);
  }
  const at = logNow();
  const out: D1PreparedStatement[] = [];
  for (const l of logs) {
    const f = fieldsOf(l, at);
    const prev = tips.get(l.organizationId) ?? null;
    const rowHash = await computeHash(prev, f);
    tips.set(l.organizationId, rowHash);
    const binds = [
      f.at, f.organization_id, f.transfer_id, f.event, f.actor_type, f.actor_id, f.reason,
      f.detail == null ? null : JSON.stringify(f.detail),
      f.agent_provider, f.agent_model, f.agent_input_mode, f.agent_p_approve, f.agent_threshold, f.agent_input_sha256,
      prev, rowHash,
    ];
    const placeholders = binds.map((_, i) => `?${i + 1}`).join(", ");
    const sql = conditional
      ? `INSERT INTO decision_log (${INSERT_COLS}) SELECT ${placeholders} WHERE changes() > 0`
      : `INSERT INTO decision_log (${INSERT_COLS}) VALUES (${placeholders})`;
    out.push(d1.prepare(sql).bind(...binds));
  }
  return out;
}

function isChainCollision(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message ?? err) + String((err as { cause?: unknown })?.cause ?? "");
  return msg.includes("UNIQUE constraint failed") && msg.includes("decision_log");
}

/**
 * Write `guard` (optional) and the log rows atomically. Returns false when the guard changed no row
 * (nothing was logged). `after` statements run in the same batch, after the log rows, and must carry
 * their own conditions.
 */
export async function commit(
  d1: D1Database,
  opts: { guard?: D1PreparedStatement; logs: LogInput[]; after?: D1PreparedStatement[] },
): Promise<boolean> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const inserts = await insertStatements(d1, opts.logs, !!opts.guard);
    const batch = [...(opts.guard ? [opts.guard] : []), ...inserts, ...(opts.after ?? [])];
    if (!batch.length) return true;
    try {
      const results = await d1.batch(batch);
      if (opts.guard) return (results[0]?.meta?.changes ?? 0) > 0;
      return true;
    } catch (err) {
      if (!isChainCollision(err)) throw err;
      await new Promise((r) => setTimeout(r, 5 + Math.random() * 20 * (attempt + 1)));
    }
  }
  throw new Error("decision_log: could not append after repeated chain collisions");
}

/** Append log rows with no guard. */
export async function append(d1: D1Database, ...logs: LogInput[]): Promise<void> {
  await commit(d1, { logs });
}

export async function verifyChain(d1: D1Database, organizationId: string): Promise<{ ok: boolean; rows: number; first_bad_id: number | null }> {
  let prev: string | null = null;
  let count = 0;
  let lastId = 0;
  for (;;) {
    const { results } = await d1
      .prepare("SELECT * FROM decision_log WHERE organization_id = ?1 AND id > ?2 ORDER BY id ASC LIMIT 500")
      .bind(organizationId, lastId)
      .all<LogRow>();
    if (!results.length) break;
    for (const row of results) {
      count++;
      const detail = row.detail == null ? null : JSON.parse(row.detail);
      const expected = await computeHash(row.prev_hash, { ...row, detail });
      if ((row.prev_hash ?? null) !== prev || expected !== row.row_hash) return { ok: false, rows: count, first_bad_id: row.id };
      prev = row.row_hash;
      lastId = row.id;
    }
  }
  return { ok: true, rows: count, first_bad_id: null };
}
