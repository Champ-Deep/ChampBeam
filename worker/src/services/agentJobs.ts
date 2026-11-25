/**
 * Agent jobs: the one seam A1 (forward follow-up drafts) and A2 (page from a brief) use to reach a model.
 * Provider and the enabled switch stay global (assistant_config); the model can be overridden per job
 * (assistant_job_models). Each job has its own per-user daily cap and token budget, and asks for JSON.
 */
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { assistantJobModels } from "../db/schema";
import type { Ctx, Settings } from "../env";
import { HTTPError } from "../lib/errors";
import { enforceLimit } from "../lib/ratelimit";
import { AssistantError, complete, configRow, providerConfigured, type ChatMessage } from "./assistant";

export const AGENT_JOBS = ["forward_followup", "page_from_brief"] as const;
export type AgentJob = (typeof AGENT_JOBS)[number];
export const JOB_DAILY_LIMIT: Record<AgentJob, number> = { forward_followup: 30, page_from_brief: 10 };
export const JOB_MAX_TOKENS: Record<AgentJob, number> = { forward_followup: 600, page_from_brief: 1800 };

/** Every job's override, null where the job uses the global model. */
export async function jobModels(db: Db): Promise<Record<AgentJob, string | null>> {
  const byJob = new Map((await db.select().from(assistantJobModels)).map((r) => [r.job, r.model]));
  return { forward_followup: byJob.get("forward_followup") ?? null, page_from_brief: byJob.get("page_from_brief") ?? null };
}

/** The model a job runs on: its override row, else assistant_config.model. */
export async function jobModel(db: Db, s: Settings, job: AgentJob): Promise<string> {
  const [row] = await db.select().from(assistantJobModels).where(eq(assistantJobModels.job, job));
  return row?.model ?? (await configRow(db, s)).model;
}

/** One JSON completion for `job`. Every failure is an AssistantError with a fixed detail string. */
export async function completeJob(
  c: Ctx,
  userId: string,
  job: AgentJob,
  messages: ChatMessage[],
): Promise<{ reply: string; model: string; provider: string; usage: { prompt_tokens: number; completion_tokens: number } }> {
  const s = c.var.settings;
  const row = await configRow(c.var.db, s);
  if (!s.assistantEnabled || !row.enabled) throw new AssistantError(503, "The assistant is disabled.");
  if (!providerConfigured(s, row.provider)) throw new AssistantError(503, `The ${row.provider} provider has no API key configured.`);
  try {
    await enforceLimit(c.env.DB, `agent:${job}:${userId}`, JOB_DAILY_LIMIT[job], 86400, "Daily limit reached for this agent. Try again tomorrow.");
  } catch (err) {
    // One error type for callers: they map AssistantError to the HTTP answer, as routes/assistant.ts does.
    if (err instanceof HTTPError) throw new AssistantError(err.status, String(err.detail));
    throw err;
  }
  const model = await jobModel(c.var.db, s, job);
  const { reply, usage } = await complete(s, row.provider, messages, model, JOB_MAX_TOKENS[job], { json: true, job });
  return { reply, model, provider: row.provider, usage };
}
