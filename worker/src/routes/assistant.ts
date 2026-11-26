/**
 * Assistant API: guided feature helper with an admin provider picker. Port of
 * backend/app/api/v1/assistant.py, mounted at /api/v1/assistant. Request and response shapes are unchanged.
 *
 * - GET  /config: provider/model/enabled, which providers have a key, the suggested free models.
 * - PUT  /config: org-admin only. The row is a GLOBAL singleton, so "has no org" must never pass.
 *   Optional `job_models` sets the per-job model overrides of the agent jobs (services/agentJobs.ts).
 * - POST /chat: one reply from the chosen provider. 503 when disabled or the provider key is missing.
 * - POST /pages: A2, a brief to a branded one-pager. Dry run (default) returns the HTML; dry_run false
 *   publishes it through the Pages publish path. The model writes copy only; the template writes markup.
 */
import { Hono } from "hono";
import { z } from "zod";
import { isOrgAdmin, requireSessionAuth } from "../auth/security";
import type { AppEnv, Ctx } from "../env";
import { httpError } from "../lib/errors";
import { enforceLimit } from "../lib/ratelimit";
import { parseJson } from "../lib/validate";
import { assistantConfig, assistantJobModels } from "../db/schema";
import { eq } from "drizzle-orm";
import { AGENT_JOBS, completeJob, jobModels } from "../services/agentJobs";
import { assertCanShare } from "../services/domains";
import { PageContent, renderChampionsGroup } from "../services/pageTemplates/championsGroup";
import { pageResponse, publish, utf8 } from "./pages";
import {
  ASSISTANT_PROVIDERS,
  AssistantError,
  SUGGESTED_FREE_MODELS,
  buildMessages,
  complete,
  configRow,
  overviewFor,
  providerConfigured,
} from "../services/assistant";

export const router = new Hono<AppEnv>({ strict: false });

/** Every /chat call spends money at a third-party model provider: metered per user. */
const CHAT_LIMIT_PER_MINUTE = 20;
/** Total characters across one request (the schema allows 40 x 8000; nobody needs that). */
export const MAX_TOTAL_CHARS = 32_000;

const ChatRequest = z.object({
  messages: z
    .array(z.object({ role: z.enum(["user", "assistant", "system"]), content: z.string().min(1).max(8000) }))
    .min(1)
    .max(40),
  max_tokens: z.number().int().min(64).max(2048).nullish(),
});

const ConfigPut = z.object({
  provider: z.enum(ASSISTANT_PROVIDERS).default("openrouter"),
  model: z.string().max(160).nullish(),
  enabled: z.boolean().nullish(),
  // Per job: a string upserts that job's model, null deletes the override, an absent key leaves it.
  job_models: z
    .object({
      forward_followup: z.string().trim().min(1).max(160).nullable().optional(),
      page_from_brief: z.string().trim().min(1).max(160).nullable().optional(),
    })
    .optional(),
});

async function configPayload(c: Ctx, row: { provider: string; model: string; enabled: boolean }) {
  const s = c.var.settings;
  return {
    provider: row.provider,
    model: row.model,
    enabled: s.assistantEnabled && row.enabled,
    providers: [...ASSISTANT_PROVIDERS].map((id) => ({
      id,
      configured: providerConfigured(s, id),
      free_models: SUGGESTED_FREE_MODELS[id] ?? [],
    })),
    job_models: await jobModels(c.var.db),
  };
}

router.get("/config", async (c) => {
  await requireSessionAuth(c);
  return c.json(await configPayload(c, await configRow(c.var.db, c.var.settings)));
});

router.put("/config", async (c) => {
  const user = await requireSessionAuth(c);
  if (!isOrgAdmin(user)) httpError(403, "Only organization admins can configure the assistant.");
  const data = await parseJson(c, ConfigPut);
  const row = await configRow(c.var.db, c.var.settings);
  const model = data.model?.trim();
  const [updated] = await c.var.db
    .update(assistantConfig)
    .set({ provider: data.provider, ...(model ? { model } : {}), ...(data.enabled != null ? { enabled: data.enabled } : {}) })
    .where(eq(assistantConfig.id, row.id))
    .returning();
  for (const job of AGENT_JOBS) {
    const jobModel = data.job_models?.[job];
    if (jobModel === undefined) continue;
    if (jobModel === null) await c.var.db.delete(assistantJobModels).where(eq(assistantJobModels.job, job));
    else {
      const set = { model: jobModel, updatedAt: new Date().toISOString() };
      await c.var.db.insert(assistantJobModels).values({ job, ...set }).onConflictDoUpdate({ target: assistantJobModels.job, set });
    }
  }
  return c.json(await configPayload(c, updated!));
});

router.post("/chat", async (c) => {
  const user = await requireSessionAuth(c);
  await enforceLimit(c.env.DB, `assistant:${user.userId}`, CHAT_LIMIT_PER_MINUTE, 60, "Too many assistant messages. Wait a minute and try again.");
  const data = await parseJson(c, ChatRequest);
  if (data.messages.reduce((n, m) => n + m.content.length, 0) > MAX_TOTAL_CHARS) {
    httpError(413, `The conversation is too long (over ${MAX_TOTAL_CHARS} characters). Start a new chat.`);
  }
  const s = c.var.settings;
  const row = await configRow(c.var.db, s);
  if (!s.assistantEnabled || !row.enabled) httpError(503, "The assistant is disabled.");
  if (!providerConfigured(s, row.provider)) {
    httpError(
      503,
      `The ${row.provider} provider has no API key configured. Add it as a Worker secret, then pick the provider in Settings > Assistant.`,
    );
  }
  const messages = buildMessages(data.messages, await overviewFor(c.var.db, user.userId), s.assistantMaxHistory);
  try {
    const { reply, usage } = await complete(s, row.provider, messages, row.model, data.max_tokens ?? s.assistantMaxTokens);
    return c.json({ reply, provider: row.provider, model: row.model, usage });
  } catch (err) {
    if (err instanceof AssistantError) httpError(err.status, err.detail);
    throw err;
  }
});

// ---------------------------------------------------------------------------
// A2: page from a brief
// ---------------------------------------------------------------------------

const PAGE_LIMIT_PER_MINUTE = 4;
/** One renderer per brand; the LakeB2B template (t_848b6c40) adds a key here and to the enum. */
const PAGE_TEMPLATES = { "champions-group": renderChampionsGroup } as const;

const PageRequest = z.object({
  company: z.string().trim().min(1).max(120),
  brief: z.string().trim().min(20).max(2000),
  brand: z.enum(["champions-group"]),
  cta_url: z.url({ protocol: /^https$/ }).max(500).optional(),
  title: z.string().trim().min(1).max(120).optional(),
  slug: z.string().optional(),
  domain_id: z.string().optional(),
  dry_run: z.boolean().default(true),
});

const PAGE_SCHEMA_TEXT = `{"headline": string (8 to 90 chars), "subhead": string (0 to 200), "pains": string[] (2 to 4 items, each 4 to 160), "how_we_help": {"title": string (2 to 60), "body": string (10 to 280)}[] (2 to 4 items), "proof": string[] (0 to 3 items, each up to 160), "cta_label": string (2 to 40)}`;

export function pageMessages(company: string, brief: string) {
  return [
    {
      role: "system" as const,
      content:
        `You write the copy for a one-page sales leave-behind from Champions Group to ${company}. Use only facts in the BRIEF. No numbers, client names, quotes or claims that are not in the brief. Plain words, short sentences, no hype words (revolutionary, cutting-edge, game-changing, synergy). Return JSON matching the schema.` +
        `\n\nSchema: ${PAGE_SCHEMA_TEXT}`,
    },
    { role: "user" as const, content: `BRIEF:\n${brief}` },
  ];
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ");

/** Figures in the draft that the brief and company name do not contain (the model must not invent numbers). */
export function inventedFigures(content: PageContent, brief: string, company: string): string[] {
  const strings = [
    content.headline,
    content.subhead,
    ...content.pains,
    ...content.how_we_help.flatMap((s) => [s.title, s.body]),
    ...content.proof,
    content.cta_label,
  ];
  const source = norm(`${brief}\n${company}`);
  const found = strings.flatMap((s) => s.match(/\d[\d,.]*\s*(%|x|k|m|bn|million|billion)?/gi) ?? []);
  // A sentence-ending "." or "," is punctuation, not part of the figure ("in 2026." vs a brief saying "2026").
  const figures = [...new Set(found.map((f) => norm(f.trim()).replace(/[.,]+$/, "")))];
  return figures.filter((f) => !source.includes(f));
}

router.post("/pages", async (c) => {
  const user = await requireSessionAuth(c);
  assertCanShare(user);
  await enforceLimit(c.env.DB, `agent:page:${user.userId}`, PAGE_LIMIT_PER_MINUTE, 60, "Too many page drafts. Wait a minute and try again.");
  const data = await parseJson(c, PageRequest);

  let job: Awaited<ReturnType<typeof completeJob>>;
  try {
    job = await completeJob(c, user.userId, "page_from_brief", pageMessages(data.company, data.brief));
  } catch (err) {
    if (err instanceof AssistantError) httpError(err.status, err.detail);
    throw err;
  }
  let content: PageContent;
  try {
    content = PageContent.parse(JSON.parse(job.reply));
  } catch {
    httpError(502, "The model returned an unexpected page draft. Try again.");
  }
  const invented = inventedFigures(content, data.brief, data.company);
  if (invented.length) {
    httpError(422, `The draft contained figures not in the brief: ${invented.join(", ")}. Edit the brief or try again.`);
  }

  const title = data.title || `${data.company}: ${content.headline}`.slice(0, 120);
  const html = PAGE_TEMPLATES[data.brand](content, { company: data.company, ctaUrl: data.cta_url, title });
  if (data.dry_run) {
    return c.json({ html, content, model: job.model, usage: job.usage, checks: { figures_ok: true, bytes: utf8(html).length } });
  }
  const asset = await publish(c, {
    user,
    payload: utf8(html),
    title,
    slug: data.slug,
    domainId: data.domain_id,
    filename: null,
    contentType: "text/html",
  });
  const page = await pageResponse(c, asset);
  return c.json({ page, url: page.url, model: job.model, usage: job.usage }, 201);
});
