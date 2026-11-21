/**
 * Review agent (BRD 7.2, AGT-1 to AGT-9; P1 local scorer, P2 Jev). Port of backend/app/services/review_agent.py.
 *
 * Off by default. When an org turns it on, the sweeper looks at pending transfers whose wait window has
 * passed and that it has not evaluated before:
 *   1. deterministic checks first (scan clean, size/type ok, sha256 known and not seen before) - any
 *      failure escalates to a human without calling a scorer (AGT-3);
 *   2. the configured provider, then Clef, then a human (AGT-7) - an error or timeout is never approval;
 *   3. at or above the threshold the agent approves; below it escalates. It never rejects (AGT-6).
 */
import type { Env, Settings } from "../env";
import { nowIso } from "../lib/time";
import * as C from "./constants";
import { canonicalJson, commit } from "./decisionLog";
import * as T from "./transfers";
import { reportError } from "../lib/observability";

export const PROVIDER_CLEF = "clef";
export const PROVIDER_JEV = "jev";
export const PROVIDER_MOCK = "mock";

export const CRITERIA = [
  { name: "business_purpose", question: "Does the purpose note describe a plausible internal business reason for this transfer?" },
  { name: "file_matches_purpose", question: "Do the file name, type and size fit the stated purpose?" },
  { name: "recipient_fit", question: "Is the recipient a sensible person to receive this file given the purpose?" },
  { name: "no_sensitive_red_flags", question: "Is there no sign of credentials, personal data dumps, or data leaving its intended team?" },
];
export const QUESTION = "Should IT release this internal file transfer without a human review?";
export const JEV_DECISION_KEY = "release";

export class ScorerError extends Error {}

export interface ScoreResult {
  p_approve: number;
  reasons: string[];
  model: string;
  version: string;
  provider: string;
}

export type Payload = Record<string, unknown>;
export type Scorer = (payload: Payload) => Promise<ScoreResult>;

const validProb = (p: unknown): p is number => typeof p === "number" && Number.isFinite(p) && p >= 0 && p <= 1;

export function validate(data: unknown, provider: string): ScoreResult {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new ScorerError("scorer returned a non-object response");
  const d = data as Record<string, unknown>;
  if (!validProb(d.p_approve)) throw new ScorerError("scorer returned an invalid p_approve");
  let reasons = d.reasons ?? [];
  if (!Array.isArray(reasons)) reasons = [String(reasons)];
  return {
    p_approve: d.p_approve,
    reasons: (reasons as unknown[]).slice(0, 10).map((r) => String(r).slice(0, 500)),
    model: String(d.model || "unknown").slice(0, 120),
    version: String(d.version || "unknown").slice(0, 60),
    provider,
  };
}

async function postJson(url: string, body: unknown, headers: Record<string, string>, timeoutS: number, name: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...headers }, signal: AbortSignal.timeout(timeoutS * 1000) });
  } catch (err) {
    throw new ScorerError(`${name} request failed: ${(err as Error).name}`);
  }
  if (res.status !== 200) throw new ScorerError(`${name} returned HTTP ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new ScorerError(`${name} returned invalid JSON`);
  }
}

export function clefScorer(settings: Settings): Scorer {
  return async (payload) => {
    if (!settings.clefConfigured) throw new ScorerError("Clef is not configured");
    const headers: Record<string, string> = settings.clefToken ? { Authorization: `Bearer ${settings.clefToken}` } : {};
    const data = await postJson(settings.clefUrl, { question: QUESTION, criteria: CRITERIA, input: payload }, headers, settings.clefTimeoutS, "Clef");
    return validate(data, PROVIDER_CLEF);
  };
}

/** Jev is only ever given metadata (AGT-5): content_excerpt is stripped whatever the org setting says. */
export function jevRequest(settings: Settings, payload: Payload) {
  const state = Object.fromEntries(Object.entries(payload).filter(([k]) => k !== "content_excerpt"));
  const questions: Record<string, { type: string; instructions: string }> = {
    [JEV_DECISION_KEY]: {
      type: "noul",
      instructions:
        "state describes an internal file transfer. Statement: IT can release this file to the recipient without a human review, because every criterion below holds. " +
        CRITERIA.map((c) => c.question).join(" "),
    },
  };
  for (const c of CRITERIA) questions[c.name] = { type: "noul", instructions: `state describes an internal file transfer. Statement: ${c.question}` };
  return { model: settings.jevModel, state, questions };
}

function noul(answers: Record<string, unknown>, key: string): number | null {
  const a = answers[key] as Record<string, unknown> | undefined;
  if (!a || typeof a !== "object" || a.type !== "noul") return null;
  return validProb(a.noul) ? a.noul : null;
}

export function jevScorer(settings: Settings): Scorer {
  return async (payload) => {
    if (!settings.jevConfigured) throw new ScorerError("Jev is not configured");
    const data = (await postJson(settings.jevUrl, jevRequest(settings, payload), { Authorization: `Bearer ${settings.jevApiKey}` }, settings.jevTimeoutS, "Jev")) as Record<string, unknown>;
    const answers = data && typeof data === "object" ? (data.answers as Record<string, unknown> | undefined) : undefined;
    if (!answers || typeof answers !== "object") throw new ScorerError("Jev returned no answers");
    const p = noul(answers, JEV_DECISION_KEY);
    if (p === null) throw new ScorerError("Jev returned an invalid release probability");
    const reasons = CRITERIA.map((c) => {
      const cp = noul(answers, c.name);
      return `${c.name}: ${cp === null ? "unjudged" : cp.toFixed(2)}`;
    });
    const model = String(data.model || settings.jevModel);
    return validate({ p_approve: p, reasons, model, version: model.split("-").pop() }, PROVIDER_JEV);
  };
}

/** Deterministic rules for tests and demos (REVIEW_AGENT_ALLOW_MOCK). Never a production scorer. */
export const mockScorer: Scorer = async (payload) => {
  const purpose = String(payload.purpose ?? "");
  let p = purpose.trim().length >= 12 ? 0.97 : 0.4;
  if (purpose.toLowerCase().includes("reject")) p = 0.1;
  return { p_approve: p, reasons: [`purpose length ${purpose.length}`], model: "mock-rules", version: "1", provider: PROVIDER_MOCK };
};

export type ScorerFactory = (provider: string) => Scorer;

export function defaultScorers(settings: Settings): ScorerFactory {
  return (provider) => {
    if (provider === PROVIDER_CLEF) return clefScorer(settings);
    if (provider === PROVIDER_JEV && settings.jevConfigured) return jevScorer(settings);
    if (provider === PROVIDER_MOCK && settings.reviewAgentAllowMock) return mockScorer;
    return async () => {
      throw new ScorerError(`Provider '${provider}' is not available`);
    };
  };
}

export function providerChain(settings: Settings, mode: string): string[] {
  if (mode === C.AGENT_JEV) return [PROVIDER_JEV, PROVIDER_CLEF];
  if (mode === C.AGENT_LOCAL) return settings.reviewAgentAllowMock && !settings.clefConfigured ? [PROVIDER_MOCK] : [PROVIDER_CLEF];
  return [];
}

export async function canonicalSha256(payload: Payload): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(payload)));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const TEXT_MIMES = new Set(["application/json", "application/xml", "application/csv", "application/x-ndjson"]);

async function excerpt(env: Env, settings: Settings, f: { mime_type: string | null; filename: string; storage_key: string }): Promise<string | null> {
  const mime = (f.mime_type ?? "").toLowerCase().split(";")[0].trim();
  const name = f.filename.toLowerCase();
  const texty = mime.startsWith("text/") || TEXT_MIMES.has(mime) || [".csv", ".tsv", ".txt", ".json", ".md"].some((e) => name.endsWith(e));
  if (!texty) return null;
  const obj = await env.FILES.get(f.storage_key, { range: { offset: 0, length: settings.reviewAgentExcerptBytes } });
  if (!obj) return null;
  return new TextDecoder().decode(await obj.arrayBuffer());
}

export async function buildInput(env: Env, settings: Settings, t: T.TransferRow, inputMode: string, includeContent = true): Promise<Payload> {
  const f = await env.DB.prepare("SELECT filename, size_bytes, mime_type, storage_key FROM file_assets WHERE id = ?1")
    .bind(t.file_id)
    .first<{ filename: string; size_bytes: number; mime_type: string | null; storage_key: string }>();
  const who = async (id: string) => {
    const u = await env.DB.prepare("SELECT full_name, email FROM users WHERE id = ?1").bind(id).first<{ full_name: string | null; email: string | null }>();
    return { name: u?.full_name ?? null, email: u?.email ?? null };
  };
  const payload: Payload = {
    filename: f?.filename ?? null,
    size_bytes: f?.size_bytes ?? null,
    mime_type: f?.mime_type ?? null,
    submitter: await who(t.submitter_user_id),
    recipient: await who(t.recipient_user_id),
    purpose: t.purpose,
    requested_expires_in_days: t.requested_expires_in_days,
    requested_one_time: !!t.requested_one_time,
    hard_checks: t.check_results ? JSON.parse(t.check_results) : {},
    malware_scan: t.scan_status,
    input_mode: inputMode,
  };
  if (inputMode === C.INPUT_CONTENT_EXCERPT && includeContent && f) payload.content_excerpt = await excerpt(env, settings, f);
  return payload;
}

export async function deterministicFailures(d1: D1Database, t: T.TransferRow): Promise<string[]> {
  const failures: string[] = [];
  if (t.scan_status !== C.SCAN_CLEAN) failures.push(`malware scan is '${t.scan_status || "missing"}', not clean`);
  const checks = t.check_results ? JSON.parse(t.check_results) : {};
  for (const k of ["size", "type"]) if (checks[k] !== "ok") failures.push(`${k} check did not pass`);
  const f = await d1.prepare("SELECT sha256 FROM file_assets WHERE id = ?1").bind(t.file_id).first<{ sha256: string | null }>();
  if (!f?.sha256) failures.push("integrity hash not available");
  else {
    const dup = await d1
      .prepare("SELECT 1 FROM transfers t JOIN file_assets f ON f.id = t.file_id WHERE t.organization_id = ?1 AND t.id != ?2 AND f.sha256 = ?3 LIMIT 1")
      .bind(t.organization_id, t.id, f.sha256)
      .first();
    if (dup) failures.push("the same file (sha256) was submitted before");
  }
  return failures;
}

export async function scoreWithFallback(scorers: ScorerFactory, chain: string[], payload: Payload): Promise<{ result: ScoreResult | null; errors: string[] }> {
  const errors: string[] = [];
  for (const provider of chain) {
    try {
      return { result: await scorers(provider)(payload), errors };
    } catch (err) {
      if (err instanceof ScorerError) errors.push(`${provider}: ${err.message}`);
      else {
        reportError(`review agent: scorer ${provider} crashed`, err, { component: "intranet.review_agent", tags: { provider } });
        errors.push(`${provider}: ${(err as Error)?.name ?? "Error"}`);
      }
    }
  }
  return { result: null, errors };
}

async function escalate(d1: D1Database, t: T.TransferRow, review: T.ReviewSettings, reason: string, result: ScoreResult | null, inputSha: string | null) {
  const now = nowIso();
  const agentResult = result ? { p_approve: result.p_approve, reasons: result.reasons, provider: result.provider, model: result.model } : null;
  // Pending-only, and only once: an escalated item is not re-scored.
  const guard = d1
    .prepare(
      `UPDATE transfers SET escalated_at = ?2, agent_evaluated_at = ?2, escalation_reason = ?3, agent_result = ?4
       WHERE id = ?1 AND state IN ('${C.STATE_SUBMITTED}', '${C.STATE_IN_REVIEW}') AND agent_evaluated_at IS NULL`,
    )
    .bind(t.id, now, reason, agentResult ? JSON.stringify(agentResult) : null);
  await commit(d1, {
    guard,
    logs: [
      {
        organizationId: t.organization_id,
        transferId: t.id,
        event: C.EVENT_ESCALATED,
        actorType: C.ACTOR_AGENT,
        actorId: result ? `agent:${result.provider}` : "agent",
        reason,
        agent: {
          provider: result?.provider ?? null,
          model: result?.model ?? null,
          input_mode: review.agent_input_mode,
          p_approve: result?.p_approve ?? null,
          threshold: review.agent_threshold,
          input_sha256: inputSha,
        },
      },
    ],
  });
}

export async function evaluateTransfer(env: Env, settings: Settings, t: T.TransferRow, review: T.ReviewSettings, scorers: ScorerFactory): Promise<"approved" | "escalated"> {
  const d1 = env.DB;
  const failures = await deterministicFailures(d1, t);
  if (failures.length) {
    await escalate(d1, t, review, `Deterministic checks: ${failures.join("; ")}`, null, null);
    return "escalated";
  }
  let result: ScoreResult | null = null;
  const errors: string[] = [];
  let payload: Payload = {};
  for (const provider of providerChain(settings, review.agent_mode)) {
    const mode = provider === PROVIDER_JEV ? C.INPUT_METADATA_ONLY : review.agent_input_mode;
    payload = await buildInput(env, settings, t, mode);
    const r = await scoreWithFallback(scorers, [provider], payload);
    errors.push(...r.errors);
    if (r.result) {
      result = r.result;
      break;
    }
  }
  const inputSha = Object.keys(payload).length ? await canonicalSha256(payload) : null;
  if (!result) {
    await escalate(d1, t, review, `Scorer unavailable: ${(errors.length ? errors : ["no provider"]).join("; ")}`, null, inputSha);
    return "escalated";
  }
  if (result.p_approve < review.agent_threshold) {
    await escalate(d1, t, review, `Confidence ${result.p_approve.toFixed(2)} is below the ${review.agent_threshold.toFixed(2)} threshold.`, result, inputSha);
    return "escalated";
  }
  await T.approve(d1, settings, t, `agent:${result.provider}`, review, {
    reason: result.reasons.join("; ").slice(0, 1000) || null,
    actorType: C.ACTOR_AGENT,
    agent: {
      provider: result.provider,
      model: `${result.model}@${result.version}`,
      input_mode: String(payload.input_mode ?? review.agent_input_mode),
      p_approve: result.p_approve,
      threshold: review.agent_threshold,
      input_sha256: inputSha,
    },
    agentResult: { p_approve: result.p_approve, reasons: result.reasons, provider: result.provider, model: result.model },
  });
  return "approved";
}

export async function runPass(env: Env, settings: Settings, scorers: ScorerFactory = defaultScorers(settings), limit = 50) {
  const stats = { approved: 0, escalated: 0, skipped: 0, ids: [] as string[] };
  const now = nowIso();
  const { results: orgs } = await env.DB.prepare(`SELECT * FROM org_review_settings WHERE agent_mode != '${C.AGENT_OFF}'`).all<T.ReviewSettings>();
  for (const review of orgs) {
    const { results: due } = await env.DB.prepare(
      `SELECT * FROM transfers WHERE organization_id = ?1 AND state IN ('${C.STATE_SUBMITTED}', '${C.STATE_IN_REVIEW}')
         AND agent_evaluated_at IS NULL AND agent_window_ends_at IS NOT NULL AND agent_window_ends_at <= ?2
       ORDER BY submitted_at ASC LIMIT ?3`,
    )
      .bind(review.organization_id, now, limit)
      .all<T.TransferRow>();
    for (const t of due) {
      try {
        const outcome = await evaluateTransfer(env, settings, t, review, scorers);
        stats.ids.push(t.id);
        if (outcome === "approved") stats.approved++;
        else stats.escalated++;
      } catch (err) {
        reportError(`review agent: evaluating ${t.id} failed`, err, { component: "intranet.review_agent", tags: { transfer_id: t.id } });
        stats.skipped++;
      }
    }
  }
  return stats;
}
