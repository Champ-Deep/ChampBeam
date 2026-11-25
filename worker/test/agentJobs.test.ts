/**
 * Agent jobs (services/agentJobs.ts): the completeJob seam A1 and A2 call. Mock fixtures, per-job model
 * override, per-user daily cap, the 503 gates (with no upstream fetch), JSON mode on the wire, no key leak.
 * Every test sets its own config through an admin PUT in beforeEach, so each passes alone with -t.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../src/db/client";
import { getSettings, type Ctx, type Env } from "../src/env";
import { AssistantError } from "../src/services/assistant";
import { completeJob, type AgentJob } from "../src/services/agentJobs";
import { api, awayFromWindowEdge, createUser, env, orgSession } from "./helpers";
import { restoreSettings, setSettings } from "./orgTestUtils";

// Read from the binding, never retyped: the fake key vitest.config.ts pins (taken before any setSettings patch).
const KEY = getSettings(env as unknown as Env).assistantOpenrouterApiKey;
const msgs = [{ role: "user" as const, content: "Draft a follow-up." }];
const put = (headers: HeadersInit, body: object) => api("/api/v1/assistant/config", { method: "PUT", headers, json: body });

/** The handler context completeJob reads (env.DB, var.db, var.settings), as app.ts builds it. */
const ctx = () => ({ env, var: { db: getDb(env.DB), settings: getSettings(env as unknown as Env) } }) as unknown as Ctx;
const run = (userId: string, job: AgentJob) => completeJob(ctx(), userId, job, msgs);
/** The AssistantError a rejected call throws (fails the test if it resolved or threw something else). */
async function failure(p: Promise<unknown>): Promise<AssistantError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AssistantError);
  return err as AssistantError;
}

// The fixture from the card, typed here independently of MOCK_JOB_REPLIES so a drift in either shows up.
const FIXTURE = {
  forward_followup: {
    subject: "[mock] Quick follow-up",
    body: "Hi {first_name},\n\n[mock] Happy to walk you and anyone on your team through this. Would 15 minutes this week help?",
  },
  page_from_brief: {
    headline: "[mock] A clearer path for your team",
    subhead: "[mock] One page, three steps.",
    pains: ["[mock] pain one", "[mock] pain two"],
    how_we_help: [
      { title: "[mock] Step one", body: "[mock] What we do first." },
      { title: "[mock] Step two", body: "[mock] What we do next." },
    ],
    proof: [],
    cta_label: "[mock] Book a call",
  },
};

let admin: Awaited<ReturnType<typeof orgSession>>;
beforeEach(async () => {
  admin = await orgSession({ role: "admin" });
  const known = { provider: "mock", model: "test/model", enabled: true, job_models: { forward_followup: null, page_from_brief: null } };
  expect((await put(admin.headers, known)).status).toBe(200);
});
afterEach(() => {
  restoreSettings();
  vi.restoreAllMocks();
});

describe("completeJob on the mock provider", () => {
  it("returns each job's fixture verbatim on the global model when no override is set", async () => {
    for (const job of ["forward_followup", "page_from_brief"] as const) {
      const out = await run(admin.userId!, job);
      expect(out.reply).toBe(JSON.stringify(FIXTURE[job]));
      expect(out).toMatchObject({ model: "test/model", provider: "mock", usage: { prompt_tokens: 0, completion_tokens: 0 } });
    }
  });

  it("uses the job's override row when set, and only for that job", async () => {
    expect((await put(admin.headers, { provider: "mock", job_models: { page_from_brief: "brief/model" } })).status).toBe(200);
    expect((await run(admin.userId!, "page_from_brief")).model).toBe("brief/model");
    expect((await run(admin.userId!, "forward_followup")).model).toBe("test/model");
  });
});

describe("completeJob gates", () => {
  it("caps forward_followup at 30 a day per user: the 31st answers 429, a second user is unaffected", async () => {
    await awayFromWindowEdge(86400);
    const a = (await createUser()).id;
    const b = (await createUser()).id;
    for (let i = 0; i < 30; i++) await run(a, "forward_followup");
    const err = await failure(run(a, "forward_followup"));
    expect([err.status, err.detail]).toEqual([429, "Daily limit reached for this agent. Try again tomorrow."]);
    expect((await run(b, "forward_followup")).reply).toBe(JSON.stringify(FIXTURE.forward_followup));
    // The cap is per job: the same user can still run the other job.
    expect((await run(a, "page_from_brief")).model).toBe("test/model");
  }, 60_000);

  it("answers 503 when the assistant is disabled", async () => {
    expect((await put(admin.headers, { provider: "mock", enabled: false })).status).toBe(200);
    const err = await failure(run(admin.userId!, "forward_followup"));
    expect([err.status, err.detail]).toEqual([503, "The assistant is disabled."]);
  });

  it("answers 503 for openrouter with no key and never calls fetch", async () => {
    expect((await put(admin.headers, { provider: "openrouter", model: "meta/test:free" })).status).toBe(200);
    setSettings({ assistantOpenrouterApiKey: "" });
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("no fetch expected");
    });
    const err = await failure(run(admin.userId!, "page_from_brief"));
    expect([err.status, err.detail]).toEqual([503, "The openrouter provider has no API key configured."]);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("completeJob on OpenRouter (stubbed fetch, no network)", () => {
  const stub = () =>
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).startsWith("https://openrouter.ai/")) {
        return Response.json({ choices: [{ message: { content: '{"subject":"s","body":"b"}' } }], usage: { prompt_tokens: 7, completion_tokens: 3 } });
      }
      throw new Error(`unexpected fetch ${String(input)}`);
    });

  it("sends JSON mode with reasoning off, the job model and the job token budget, and never returns the key", async () => {
    const job_models = { forward_followup: "  fwd/model  " };
    expect((await put(admin.headers, { provider: "openrouter", model: "meta/test:free", job_models })).status).toBe(200);
    const spy = stub();
    const out = await run(admin.userId!, "forward_followup");
    expect(out).toEqual({ reply: '{"subject":"s","body":"b"}', model: "fwd/model", provider: "openrouter", usage: { prompt_tokens: 7, completion_tokens: 3 } });
    expect(JSON.stringify(out)).not.toContain(KEY);

    const sent = JSON.parse(String(spy.mock.calls[0]![1]!.body));
    expect(sent).toEqual({ model: "fwd/model", messages: msgs, max_tokens: 600, response_format: { type: "json_object" }, reasoning: { enabled: false } });
  });

  it("maps an upstream failure to a fixed string without the key or the provider body", async () => {
    expect((await put(admin.headers, { provider: "openrouter", model: "meta/test:free" })).status).toBe(200);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(`boom ${KEY}`, { status: 500 }));
    const err = await failure(run(admin.userId!, "page_from_brief"));
    expect(err.status).toBe(502);
    expect(err.detail).not.toContain(KEY);
    expect(err.detail).not.toContain("boom");
  });

  it("adds response_format but not reasoning for the vercel provider", async () => {
    expect((await put(admin.headers, { provider: "vercel", model: "openai/gpt-4o-mini" })).status).toBe(200);
    setSettings({ assistantVercelApiKey: "vercel-fake-key" });
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ choices: [{ message: { content: "{}" } }] }));
    await run(admin.userId!, "page_from_brief");
    const sent = JSON.parse(String(spy.mock.calls[0]![1]!.body));
    expect(sent).toMatchObject({ max_tokens: 1800, response_format: { type: "json_object" } });
    expect(sent).not.toHaveProperty("reasoning");
  });
});
