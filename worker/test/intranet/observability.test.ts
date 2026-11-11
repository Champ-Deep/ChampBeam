import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { buildEvent, parseDsn, reportError, scrubPath, scrubText, withObservability } from "../../src/lib/observability";
import { awayFromWindowEdge } from "../helpers";
import { BASE, api } from "./helpers";

const DSN = "https://abc123@glitchtip.example.com/7";
const ENDPOINT = "https://glitchtip.example.com/api/7/envelope/";

function captureGlitchtip() {
  const real = globalThis.fetch;
  const sent: { url: string; init: RequestInit }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://glitchtip.example.com/")) {
      sent.push({ url, init: init ?? {} });
      return new Response("{}", { status: 200 });
    }
    return real(input, init);
  });
  return sent;
}

function eventOf(body: unknown) {
  const lines = String(body).split("\n");
  expect(lines).toHaveLength(3);
  expect(JSON.parse(lines[1]!)).toEqual({ type: "event" });
  return JSON.parse(lines[2]!);
}

afterEach(() => vi.restoreAllMocks());

describe("NFR-7 observability", () => {
  it("parses a GlitchTip DSN into the envelope endpoint and key", () => {
    expect(parseDsn(DSN)).toEqual({ endpoint: ENDPOINT, key: "abc123" });
    expect(parseDsn("")).toBeNull();
    expect(parseDsn("not a url")).toBeNull();
    expect(parseDsn("https://glitchtip.example.com/7")).toBeNull();
    expect(parseDsn("https://abc@glitchtip.example.com/")).toBeNull();
  });

  it("scrubs ids, tokens, query strings, emails and file names (NFR-4)", () => {
    expect(scrubPath("/api/v1/intranet/transfers/6d0dbbf1-d2ed-46a1-874e-1f59497bc7c3/download?x=1")).toBe("/api/v1/intranet/transfers/:id/download");
    expect(scrubPath("/api/v1/intranet/download/dHJhbnNmZXIuMGFjODhiM2EtM2I3Yy00Nj")).toBe("/api/v1/intranet/download/:token");
    const text = scrubText("failed intranet/u/u1/f1/payroll-2026.xlsx for alice@example.com at /accept-invite?token=secret123");
    expect(text).not.toMatch(/payroll|alice@|secret123/);
    expect(text).toContain("intranet/u/u1/f1/[file]");
    expect(text).toContain("[email]");
  });

  it("builds a Sentry-protocol event with tags, level and a scrubbed request", () => {
    const err = new TypeError("boom for bob@example.com");
    const ev = buildEvent(err, "sweep failed", { component: "cron", level: "warning", method: "GET", path: "/api/v1/intranet/me?debug=1", tags: { job: "x" } }, { environment: "intranet", release: "1.2.3" });
    expect(ev.level).toBe("warning");
    expect(ev.environment).toBe("intranet");
    expect(ev.release).toBe("champbeam-intranet@1.2.3");
    expect(ev.tags).toEqual({ component: "cron", job: "x" });
    expect(ev.request).toEqual({ method: "GET", url: "/api/v1/intranet/me" });
    const exc = (ev.exception as { values: { type: string; value: string; stacktrace?: { frames: unknown[] } }[] }).values[0]!;
    expect(exc.type).toBe("TypeError");
    expect(exc.value).toBe("boom for [email]");
    expect(exc.stacktrace?.frames.length).toBeGreaterThan(0);
    expect(String(ev.event_id)).toMatch(/^[0-9a-f]{32}$/);
  });

  it("sends nothing when GLITCHTIP_DSN is unset", async () => {
    const sent = captureGlitchtip();
    const pending: Promise<unknown>[] = [];
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    withObservability({ ...env, GLITCHTIP_DSN: "" } as never, { waitUntil: (p) => pending.push(p) }, () => reportError("x", new Error("y"), { component: "t" }));
    await Promise.all(pending);
    expect(pending).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("posts an envelope to GlitchTip when a DSN is set, without blocking the caller", async () => {
    const sent = captureGlitchtip();
    const pending: Promise<unknown>[] = [];
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    withObservability({ ...env, GLITCHTIP_DSN: DSN, ENVIRONMENT: "intranet" } as never, { waitUntil: (p) => pending.push(p) }, () =>
      reportError("blob delete failed", new Error("R2 down for intranet/u/a/b/secret.csv"), { component: "intranet.storage" }),
    );
    await Promise.all(pending);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(ENDPOINT);
    const headers = new Headers(sent[0]!.init.headers);
    expect(headers.get("content-type")).toBe("application/x-sentry-envelope");
    expect(headers.get("x-sentry-auth")).toContain("sentry_key=abc123");
    const ev = eventOf(sent[0]!.init.body);
    expect(ev.tags.component).toBe("intranet.storage");
    expect(ev.environment).toBe("intranet");
    expect(JSON.stringify(ev)).not.toContain("secret.csv");
  });

  it("a GlitchTip outage never breaks the request", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const pending: Promise<unknown>[] = [];
    withObservability({ ...env, GLITCHTIP_DSN: DSN } as never, { waitUntil: (p) => pending.push(p) }, () => reportError("x", new Error("y"), { component: "t" }));
    await expect(Promise.all(pending)).resolves.toBeDefined();
    expect(warn).toHaveBeenCalledWith("glitchtip unreachable", expect.any(Error));
  });

  it("forwards SPA errors through the Worker entry point to GlitchTip", async () => {
    const sent = captureGlitchtip();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(`${BASE}/api/v1/intranet/client-errors`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: BASE, "cf-connecting-ip": "198.51.100.7" },
        body: JSON.stringify({ message: "Cannot read properties of undefined", stack: "at render (https://x/assets/index.js:1:200)", path: "/inbox" }),
      }),
      { ...env, GLITCHTIP_DSN: DSN } as never,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(204);
    expect(sent).toHaveLength(1);
    const ev = eventOf(sent[0]!.init.body);
    expect(ev.tags).toEqual({ component: "intranet.spa", kind: "error" });
    expect(ev.exception.values[0].type).toBe("ClientError");
    expect(ev.request.url).toBe("/inbox");
  });

  it("validates and rate-limits SPA error reports", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await awayFromWindowEdge(60, 5_000);
    const headers = { "cf-connecting-ip": "203.0.113.9" };
    expect((await api("/api/v1/intranet/client-errors", { method: "POST", headers, json: { message: "" } })).status).toBe(422);
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) {
      statuses.push((await api("/api/v1/intranet/client-errors", { method: "POST", headers, json: { message: `e${i}` } })).status);
    }
    expect(statuses.slice(0, 19).every((s) => s === 204)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });
});
