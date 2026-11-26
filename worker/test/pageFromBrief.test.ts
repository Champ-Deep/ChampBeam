/**
 * A2: POST /api/v1/assistant/pages (brief to a Champions Group one-pager). Mock provider only, no real
 * network. Replies are stubbed by swapping MOCK_JOB_REPLIES.page_from_brief for one test and restoring it.
 * Every test sets its own config and user in beforeEach, so each passes alone with -t.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inventedFigures } from "../src/routes/assistant";
import { MOCK_JOB_REPLIES } from "../src/services/assistant";
import type { PageContent } from "../src/services/pageTemplates/championsGroup";
import { api, env, json, orgSession } from "./helpers";
import { restoreSettings, setSettings } from "./orgTestUtils";

const MOCK = MOCK_JOB_REPLIES.page_from_brief;
const BRIEF = "Acme ships late and customers cannot see where orders are. They want one view of every shipment.";
const put = (headers: HeadersInit, body: object) => api("/api/v1/assistant/config", { method: "PUT", headers, json: body });
const draft = (headers: HeadersInit, body: object) =>
  api("/api/v1/assistant/pages", { method: "POST", headers, json: { company: "Acme Logistics", brief: BRIEF, brand: "champions-group", ...body } });
const assets = async () => (await env.DB.prepare("SELECT count(*) AS n FROM file_assets").first<{ n: number }>())!.n;
const stubReply = (patch: object) => {
  MOCK_JOB_REPLIES.page_from_brief = { ...MOCK, ...patch };
};

let admin: Awaited<ReturnType<typeof orgSession>>;
beforeEach(async () => {
  admin = await orgSession({ role: "admin" });
  expect((await put(admin.headers, { provider: "mock", model: "test/model", enabled: true, job_models: { page_from_brief: null } })).status).toBe(200);
});
afterEach(() => {
  MOCK_JOB_REPLIES.page_from_brief = MOCK;
  restoreSettings();
  vi.restoreAllMocks();
});

describe("POST /api/v1/assistant/pages", () => {
  it("dry run on mock returns escaped HTML, no script or img, and writes no row", async () => {
    const before = await assets();
    const r = await draft(admin.headers, { dry_run: true, cta_url: "https://example.com/book" });
    expect(r.status, await r.clone().text()).toBe(200);
    const body = await json(r);
    expect(body.html).toContain("<h1>[mock] A clearer path for your team</h1>");
    expect(body.html).toContain("<title>Acme Logistics: [mock] A clearer path for your team</title>");
    expect(body.html).not.toContain("<script");
    expect(body.html).not.toContain("<img");
    expect(body.html).toContain('href="https://example.com/book"');
    expect(body.content).toEqual(MOCK);
    expect(body).toMatchObject({ model: "test/model", usage: { prompt_tokens: 0, completion_tokens: 0 } });
    expect(body.checks).toEqual({ figures_ok: true, bytes: new TextEncoder().encode(body.html).length });
    expect(await assets()).toBe(before);
  });

  it("treats a missing dry_run as a dry run", async () => {
    const before = await assets();
    const r = await draft(admin.headers, {});
    expect(r.status).toBe(200);
    expect((await json(r)).html).toContain("<!doctype html>");
    expect(await assets()).toBe(before);
  });

  it("dry_run false publishes a kind html page readable through the pages API", async () => {
    const before = await assets();
    const r = await draft(admin.headers, { dry_run: false });
    expect(r.status, await r.clone().text()).toBe(201);
    const body = await json(r);
    expect(await assets()).toBe(before + 1);
    const row = await env.DB.prepare("SELECT kind, slug FROM file_assets WHERE id = ?").bind(body.page.page_id).first<{ kind: string; slug: string }>();
    expect(row!.kind).toBe("html");
    expect(body.url.endsWith(`/${row!.slug}`)).toBe(true);
    const got = await api(`/api/v1/pages/${body.page.page_id}`, { headers: admin.headers });
    expect(got.status).toBe(200);
    expect((await json(got)).page_id).toBe(body.page.page_id);
  });

  it("refuses a draft with a figure the brief does not contain, and accepts it when the brief has it", async () => {
    stubReply({ headline: "Track shipments 40% faster" });
    const before = await assets();
    const r = await draft(admin.headers, { dry_run: false });
    expect(r.status).toBe(422);
    expect((await json(r)).detail).toBe("The draft contained figures not in the brief: 40%. Edit the brief or try again.");
    expect(await assets()).toBe(before);

    const ok = await draft(admin.headers, { brief: `${BRIEF} They want updates 40% faster.` });
    expect(ok.status, await ok.clone().text()).toBe(200);
  });

  it("escapes model text: a script headline renders as text", async () => {
    stubReply({ headline: "<script>alert(1)</script>" });
    // The "1" in alert(1) is a figure, so the brief carries it or the figure gate answers first.
    const r = await draft(admin.headers, { brief: `${BRIEF} Step 1 is one view.` });
    expect(r.status, await r.clone().text()).toBe(200);
    const { html } = await json(r);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script");
  });

  it("rejects javascript: and http: cta_url at validation", async () => {
    for (const cta_url of ["javascript:alert(1)", "http://example.com/book"]) {
      const r = await draft(admin.headers, { cta_url });
      expect(r.status, cta_url).toBe(422);
    }
  });

  it("answers 502 on a draft that does not match the content schema", async () => {
    stubReply({ pains: ["only one"] });
    const r = await draft(admin.headers, {});
    expect(r.status).toBe(502);
    expect((await json(r)).detail).toBe("The model returned an unexpected page draft. Try again.");
  });

  it("figure gate ignores sentence punctuation, collapses whitespace and is case-insensitive", () => {
    const c = { ...MOCK, headline: "Live in 2026. Up to 3 X more views" } as PageContent;
    expect(inventedFigures(c, "Launch 2026 with 3x views", "Acme")).toEqual(["3 x"]);
    expect(inventedFigures(c, "Launch 2026 with 3   x views", "Acme")).toEqual([]);
  });

  it("answers 503 for openrouter with no key and never calls fetch", async () => {
    expect((await put(admin.headers, { provider: "openrouter", model: "meta/test:free" })).status).toBe(200);
    setSettings({ assistantOpenrouterApiKey: "" });
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("no fetch expected");
    });
    const r = await draft(admin.headers, {});
    expect(r.status).toBe(503);
    expect((await json(r)).detail).toBe("The openrouter provider has no API key configured.");
    expect(spy).not.toHaveBeenCalled();
  });
});
