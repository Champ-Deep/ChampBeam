/**
 * Assistant API: guided feature helper with an admin provider picker. Port of
 * backend/app/api/v1/assistant.py, mounted at /api/v1/assistant. Request and response shapes are unchanged.
 *
 * - GET  /config: provider/model/enabled, which providers have a key, the suggested free models.
 * - PUT  /config: org-admin only. The row is a GLOBAL singleton, so "has no org" must never pass.
 * - POST /chat: one reply from the chosen provider. 503 when disabled or the provider key is missing.
 */
import { Hono } from "hono";
import { z } from "zod";
import { isOrgAdmin, requireSessionAuth } from "../auth/security";
import type { AppEnv, Ctx } from "../env";
import { httpError } from "../lib/errors";
import { enforceLimit } from "../lib/ratelimit";
import { parseJson } from "../lib/validate";
import { assistantConfig } from "../db/schema";
import { eq } from "drizzle-orm";
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
});

function configPayload(c: Ctx, row: { provider: string; model: string; enabled: boolean }) {
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
  };
}

router.get("/config", async (c) => {
  await requireSessionAuth(c);
  return c.json(configPayload(c, await configRow(c.var.db, c.var.settings)));
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
  return c.json(configPayload(c, updated!));
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
