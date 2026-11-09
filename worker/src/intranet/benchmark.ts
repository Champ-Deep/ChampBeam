/**
 * Agent benchmark (BRD 7.2 gate). Port of backend/app/services/agent_benchmark.py.
 *
 * Replays human approve/reject decisions from the decision log through a scorer (metadata only: blobs of
 * decided files are usually gone) and reports agreement, false releases and missed approvals across a
 * threshold sweep. No pass mark is computed: the agreement needed to switch the agent on is Deep's call.
 *
 * A run is queued by an Admin and processed by the sweeper (cron has minutes of wall time; a request's
 * waitUntil has seconds), and is also started straight away on a best-effort basis.
 */
import type { Env, Settings } from "../env";
import { nowIso } from "../lib/time";
import * as C from "./constants";
import { append } from "./decisionLog";
import * as A from "./reviewAgent";
import type { TransferRow } from "./transfers";

export const THRESHOLDS = [0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99];

export interface BenchmarkRow {
  id: string;
  organization_id: string;
  provider: string;
  status: string;
  created_at: string;
  finished_at: string | null;
  created_by_id: string | null;
  report: string | null;
  error: string | null;
}

export async function collectCases(d1: D1Database, orgId: string, limit: number): Promise<[TransferRow, number][]> {
  const labels = new Map<string, number>();
  let lastId = 0;
  for (;;) {
    const { results } = await d1
      .prepare(
        `SELECT id, transfer_id, event FROM decision_log WHERE organization_id = ?1 AND actor_type = '${C.ACTOR_HUMAN}'
           AND event IN ('${C.EVENT_APPROVED}', '${C.EVENT_REJECTED}', '${C.EVENT_OVERTURNED}') AND transfer_id IS NOT NULL AND id > ?2
         ORDER BY id ASC LIMIT 1000`,
      )
      .bind(orgId, lastId)
      .all<{ id: number; transfer_id: string; event: string }>();
    if (!results.length) break;
    for (const r of results) {
      if (r.event === C.EVENT_OVERTURNED) labels.set(r.transfer_id, 0);
      else if (!labels.has(r.transfer_id)) labels.set(r.transfer_id, r.event === C.EVENT_APPROVED ? 1 : 0);
      lastId = r.id;
    }
  }
  const ids = [...labels.keys()].slice(-limit);
  const out: [TransferRow, number][] = [];
  for (const id of ids) {
    const t = await d1.prepare("SELECT * FROM transfers WHERE id = ?1").bind(id).first<TransferRow>();
    if (t) out.push([t, labels.get(id)!]);
  }
  return out;
}

function row(threshold: number, samples: [number, number][]) {
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (const [label, p] of samples) {
    const predicted = p >= threshold;
    if (predicted && label === 1) tp++;
    else if (predicted && label === 0) fp++;
    else if (!predicted && label === 0) tn++;
    else fn++;
  }
  const n = samples.length;
  const r4 = (x: number) => Math.round(x * 10_000) / 10_000;
  return {
    threshold,
    agreement: n ? r4((tp + tn) / n) : null,
    auto_approved: tp + fp,
    coverage: n ? r4((tp + fp) / n) : null,
    false_releases: fp,
    false_release_rate: fp + tn ? r4(fp / (fp + tn)) : null,
    missed_approvals: fn,
    tp, fp, tn, fn,
  };
}

export function summarize(provider: string, samples: [number, number][], errors: string[], cases: number, currentThreshold: number, models: Set<string>) {
  const thresholds = [...new Set([...THRESHOLDS, Math.round(currentThreshold * 10_000) / 10_000])].sort((a, b) => a - b);
  return {
    provider,
    models: [...models].sort(),
    input_mode: C.INPUT_METADATA_ONLY,
    generated_at: nowIso(),
    cases,
    scored: samples.length,
    errors: errors.length,
    error_samples: errors.slice(0, 5),
    human_approved: samples.filter(([l]) => l === 1).length,
    human_rejected: samples.filter(([l]) => l === 0).length,
    current_threshold: currentThreshold,
    at_current_threshold: row(currentThreshold, samples),
    sweep: thresholds.map((t) => row(t, samples)),
    note:
      "Replays human approve/reject decisions from the decision log. Metadata only: blobs of decided files are usually deleted. " +
      "No pass/fail is computed; the agreement needed to enable the agent is Deep's call.",
  };
}

export type Report = ReturnType<typeof summarize>;

export async function run(env: Env, settings: Settings, orgId: string, provider: string, limit: number, scorers: A.ScorerFactory = A.defaultScorers(settings)): Promise<Report> {
  const review = await env.DB.prepare("SELECT agent_threshold FROM org_review_settings WHERE organization_id = ?1").bind(orgId).first<{ agent_threshold: number }>();
  const threshold = review?.agent_threshold ?? 0.95;
  const cases = await collectCases(env.DB, orgId, limit);
  const samples: [number, number][] = [];
  const errors: string[] = [];
  const models = new Set<string>();
  for (const [t, label] of cases) {
    const payload = await A.buildInput(env, settings, t, C.INPUT_METADATA_ONLY, false);
    const { result, errors: errs } = await A.scoreWithFallback(scorers, [provider], payload);
    if (!result) {
      errors.push(...(errs.length ? errs : [`${provider}: no result`]));
      continue;
    }
    models.add(`${result.model}@${result.version}`);
    samples.push([label, result.p_approve]);
  }
  return summarize(provider, samples, errors, cases.length, threshold, models);
}

export function toMarkdown(report: Report, orgName?: string | null): string {
  const lines = [
    `# Review agent benchmark${orgName ? ` — ${orgName}` : ""}`,
    "",
    `- Provider: \`${report.provider}\` (${report.models.join(", ") || "no model reported"})`,
    `- Generated: ${report.generated_at}`,
    `- Human decisions replayed: ${report.cases} (scored ${report.scored}, errors ${report.errors})`,
    `- Human approved / rejected: ${report.human_approved} / ${report.human_rejected}`,
    `- Input mode: ${report.input_mode}`,
    "",
    "| Threshold | Agreement | Auto-approved | Coverage | False releases | False-release rate | Missed approvals |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const r of report.sweep) {
    const mark = r.threshold === report.current_threshold ? " (current)" : "";
    lines.push(`| ${r.threshold}${mark} | ${r.agreement} | ${r.auto_approved} | ${r.coverage} | ${r.false_releases} | ${r.false_release_rate} | ${r.missed_approvals} |`);
  }
  lines.push("", report.note, "");
  if (report.error_samples.length) lines.push("Errors (first 5):", "", ...report.error_samples.map((e) => `- ${e}`), "");
  return lines.join("\n");
}

export function benchmarkOut(b: BenchmarkRow) {
  const report = b.report ? (JSON.parse(b.report) as Report) : null;
  return {
    id: b.id,
    provider: b.provider,
    status: b.status === "queued" ? "running" : b.status,
    created_at: b.created_at,
    finished_at: b.finished_at,
    report,
    markdown: report ? toMarkdown(report) : null,
    error: b.error,
  };
}

/** Claim and process one queued benchmark. */
export async function runJob(env: Env, settings: Settings, id: string, scorers?: A.ScorerFactory): Promise<void> {
  const res = await env.DB.prepare("UPDATE agent_benchmarks SET status = 'running' WHERE id = ?1 AND status = 'queued'").bind(id).run();
  if ((res.meta.changes ?? 0) !== 1) return;
  const b = (await env.DB.prepare("SELECT * FROM agent_benchmarks WHERE id = ?1").bind(id).first<BenchmarkRow>())!;
  let report: Report | null = null;
  let status = "done";
  let error: string | null = null;
  try {
    report = await run(env, settings, b.organization_id, b.provider, settings.reviewAgentBenchmarkMaxRows, scorers);
  } catch (err) {
    console.error(`agent benchmark ${id} failed`, err);
    status = "failed";
    error = String((err as Error)?.message ?? err).slice(0, 500);
  }
  await env.DB.prepare("UPDATE agent_benchmarks SET status = ?2, report = ?3, error = ?4, finished_at = ?5 WHERE id = ?1")
    .bind(id, status, report ? JSON.stringify(report) : null, error, nowIso())
    .run();
  await append(env.DB, {
    organizationId: b.organization_id,
    event: C.EVENT_BENCHMARK_RUN,
    actorType: C.ACTOR_SYSTEM,
    actorId: "benchmark",
    detail: { benchmark_id: id, provider: b.provider, status, scored: report?.scored ?? 0, agreement_at_current: report?.at_current_threshold.agreement ?? null },
  });
}

export async function runQueued(env: Env, settings: Settings): Promise<void> {
  // A run whose Worker was evicted never finishes: fail it so a new one can start.
  await env.DB.prepare("UPDATE agent_benchmarks SET status = 'failed', error = 'Interrupted.', finished_at = ?1 WHERE status = 'running' AND created_at < ?2")
    .bind(nowIso(), new Date(Date.now() - 2 * 3_600_000).toISOString())
    .run();
  const { results } = await env.DB.prepare("SELECT id FROM agent_benchmarks WHERE status = 'queued' ORDER BY created_at LIMIT 2").all<{ id: string }>();
  for (const r of results) await runJob(env, settings, r.id);
}
