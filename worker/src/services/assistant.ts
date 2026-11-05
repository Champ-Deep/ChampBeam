/**
 * Assistant: a guided feature helper, provider-swappable. Port of backend/app/services/assistant.py.
 *
 * Providers: OpenRouter and the Vercel AI Gateway (both OpenAI-compatible chat completions) plus a
 * deterministic `mock` for tests and keyless dev. API keys are Worker secrets, never D1; which provider
 * and model are live comes from the assistant_config singleton row (id = 1).
 */
import { count, eq, and, ne } from "drizzle-orm";
import type { Db } from "../db/client";
import { assistantConfig, fileAssets, linkClicks, FILE_KIND_HTML, FILE_STATUS_DELETED } from "../db/schema";
import type { Settings } from "../env";

export const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
export const ASSISTANT_PROVIDERS = ["mock", "openrouter", "vercel"] as const;
export type AssistantProvider = (typeof ASSISTANT_PROVIDERS)[number];

export const SUGGESTED_FREE_MODELS: Record<string, string[]> = {
  openrouter: [
    "meta-llama/llama-3.3-70b-instruct:free",
    "deepseek/deepseek-chat-v3-0324:free",
    "qwen/qwen-2.5-72b-instruct:free",
    "google/gemini-2.0-flash-exp:free",
  ],
  // On the Vercel AI Gateway the model name is the routing name for the upstream you connected a key for.
  vercel: ["google/gemini-2.5-flash", "openai/gpt-4o-mini", "anthropic/claude-3-5-haiku-latest", "meta-llama/llama-3.3-70b-instruct"],
};

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

/** Upstream/provider failure with the status the API layer returns. */
export class AssistantError extends Error {
  constructor(
    public status: number,
    public detail: string,
  ) {
    super(detail);
  }
}

function systemPrompt(o: { links: number; files: number; pages: number }): string {
  return `You are Champ, the friendly guide inside Champbeam (a link, file and page sharing platform with tracking). Your only job is to help the signed-in user understand Champbeam's features, why each one is useful for THEM, and how to find and use them, in a short, fun, guided way. You are not a general-purpose assistant: keep answers about Champbeam and how to get things done with it.

House style:
- Short answers (2-5 sentences usually). One tiny emoji at most. No walls of text.
- Suggest exactly ONE next thing to try at the end, phrased as an action ("Try: ...").
- When the user names a goal, map it to the smallest feature that achieves it and give the exact UI location (sidebar item or generator step).
- Never invent features, buttons, or URLs. If you do not know, say so and point at the Pages or Links sections of the app.
- Be warm and a little playful; never corporate.

Feature map (what / why / where):
- Generator (home): paste any link to get a short tracked link plus QR code; every open is counted with device, location and browser. Great before you send anything important.
- Named links: give a link a readable name (e.g. /s/summit) in the Generator's "Link name" field, or rename later from Links. Useful when you will share the same link repeatedly and want it recognisable.
- Files: drop a PDF/image/video into "Share a file" and get a trackable link with a live read receipt (Seen / Not opened yet). Perfect for sales assets and follow-ups.
- Pages: publish a single HTML file (checklist, dashboard, proposal) at a clean /p/ address with view, revisit and dwell tracking, versions you can roll back, and an optional 4-8 digit access code. Beam State gives the page shared comments and checklist state without any backend.
- Publish a set: drop several HTML files together; Champbeam publishes them as pages AND rewrites their links to each other into the clean /p/ URLs automatically. Use for multi-page plans, funnels, dashboards with subpages.
- Links panel on any page: see every link inside that page and reroute any of them (or auto-map old /f/ links to your pages) without editing HTML; changes become a new version you can roll back.
- UTM: tag links with source/medium/campaign (presets in Links > folder or Generator), bulk-generate from a CSV, or use "Add UTM parameters to your links" on the Links page for tagged URLs with NO short link or tracking (for ad platforms).
- Analytics: per link, file and page: views, unique, revisits, dwell, geo map, devices. From any row's Analytics button.
- Custom domains: host your links/pages on your own domain from Settings > Custom domains.
- Teams: admins curate a shared content library; members mint their own tracked links from it; Team Analytics rolls engagement up per content item.

The user's current usage (do not repeat verbatim, just use it to guide):
- Tracked links: ${o.links}
- Files shared: ${o.files}
- Pages published: ${o.pages}

If they have used almost nothing, lean on the generator and one small win. If they are clearly a power user (lots of links/files/pages), skip the basics and offer the deeper tools (publish a set, reroute panel, access codes, UTM append mode).`;
}

/** System prompt plus the trimmed history. Client-sent `system` turns are dropped: only the server sets the prompt. */
export function buildMessages(history: ChatMessage[], overview: { links: number; files: number; pages: number }, maxHistory: number): ChatMessage[] {
  const turns = history.filter((m) => m.role !== "system").slice(-maxHistory);
  return [{ role: "system", content: systemPrompt(overview) }, ...turns];
}

/** Usage counts injected into the prompt so suggestions land on what the user has not tried yet. */
export async function overviewFor(db: Db, userId: string) {
  const live = and(eq(fileAssets.userId, userId), ne(fileAssets.status, FILE_STATUS_DELETED));
  const [[l], [f], [p]] = await Promise.all([
    db.select({ n: count() }).from(linkClicks).where(eq(linkClicks.userId, userId)),
    db.select({ n: count() }).from(fileAssets).where(live),
    db.select({ n: count() }).from(fileAssets).where(and(live, eq(fileAssets.kind, FILE_KIND_HTML))),
  ]);
  return { links: l?.n ?? 0, files: f?.n ?? 0, pages: p?.n ?? 0 };
}

/** Can this provider be called right now (key present)? */
export function providerConfigured(s: Settings, id: string): boolean {
  if (id === "mock") return true;
  if (id === "openrouter") return !!s.assistantOpenrouterApiKey;
  if (id === "vercel") return !!s.assistantVercelApiKey;
  return false;
}

/** The singleton config row, created from env defaults on first read. */
export async function configRow(db: Db, s: Settings) {
  await db
    .insert(assistantConfig)
    .values({ id: 1, provider: s.assistantProvider, model: s.assistantModel, enabled: s.assistantEnabled })
    .onConflictDoNothing();
  const [row] = await db.select().from(assistantConfig).where(eq(assistantConfig.id, 1));
  return row!;
}

function mapError(status: number): AssistantError {
  if (status === 401) return new AssistantError(502, "Provider key rejected (401). Check the key in Settings.");
  if (status === 402) return new AssistantError(402, "The model provider needs credits/billing (402).");
  if (status === 403) return new AssistantError(403, "The provider refused this model (403). Try a free model.");
  if (status === 429) return new AssistantError(429, "Provider is rate-limiting. Wait a bit and retry.");
  return new AssistantError(502, `Model provider error (${status}).`);
}

export interface Completion {
  reply: string;
  usage: { prompt_tokens: number; completion_tokens: number };
}

/** One completion. Error details are fixed strings: a provider body or the key never reaches the caller. */
export async function complete(
  s: Settings,
  providerId: string,
  messages: ChatMessage[],
  model: string,
  maxTokens: number,
): Promise<Completion> {
  if (providerId === "mock") {
    const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
    return {
      reply:
        `[mock:${model}] Good question! You asked: ${lastUser.slice(0, 120)}. ` +
        "On Champbeam you can tag links with UTM, share files with read receipts, and publish tracked HTML pages. Try the Generator to start.",
      usage: { prompt_tokens: 0, completion_tokens: 0 },
    };
  }
  let url: string;
  let key: string;
  if (providerId === "openrouter") [url, key] = [OPENROUTER_URL, s.assistantOpenrouterApiKey];
  else if (providerId === "vercel") [url, key] = [`${s.assistantVercelGatewayUrl.replace(/\/+$/, "")}/chat/completions`, s.assistantVercelApiKey];
  else throw new AssistantError(400, `Unknown assistant provider '${providerId}'.`);

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens }),
      signal: AbortSignal.timeout(s.assistantTimeoutS * 1000),
    });
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new AssistantError(504, "The model provider timed out. Try again in a moment.");
    }
    throw new AssistantError(502, "Could not reach the model provider.");
  }
  if (resp.status !== 200) throw mapError(resp.status);

  let data: any;
  try {
    data = await resp.json();
  } catch {
    throw new AssistantError(502, "Unexpected response from the model provider.");
  }
  const reply = data?.choices?.[0]?.message?.content;
  if (reply === undefined) throw new AssistantError(502, "Unexpected response from the model provider.");
  return {
    reply: String(reply ?? ""),
    usage: { prompt_tokens: Number(data.usage?.prompt_tokens ?? 0) | 0, completion_tokens: Number(data.usage?.completion_tokens ?? 0) | 0 },
  };
}
