/**
 * Intranet P2 on the Worker: access code on release (REL-7) and the Jev provider.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { getSettings, type Settings } from "../../src/env";
import { jevRequest, jevScorer, providerChain, runPass, ScorerError, type ScorerFactory } from "../../src/intranet/reviewAgent";
import { api, approve, env, json, logEvents, setupOrg, submit, transferRow, waitFor } from "./helpers";

const base = () => getSettings(env as never);
const withJev = (): Settings => ({ ...base(), jevApiKey: "sk-or-test", jevConfigured: true });

const download = (m: { headers: Record<string, string> }, id: string, code?: string) =>
  api(`/api/v1/intranet/transfers/${id}/download`, { headers: { ...m.headers, ...(code ? { "X-Access-Code": code } : {}) } });

describe("REL-7: access code on release", () => {
  it("the recipient needs the code; the log records that a code was set, never the code", async () => {
    const { alice, bob, reviewer } = await setupOrg();
    const { transfer, content } = await submit(alice, bob);
    expect((await approve(reviewer, transfer.id, { access_code: "12ab" })).status).toBe(422);
    const ok = await approve(reviewer, transfer.id, { access_code: "482913" });
    expect(ok.status).toBe(200);
    expect((await json(ok)).access_code_required).toBe(true);
    const row = await transferRow(transfer.id);
    expect(row!.access_code_hash).toMatch(/^[0-9a-f]{64}$/);
    const log = await env.DB.prepare("SELECT detail FROM decision_log WHERE transfer_id = ? AND event = 'approved'").bind(transfer.id).first<{ detail: string }>();
    expect(JSON.parse(log!.detail)).toMatchObject({ access_code: true });
    expect(log!.detail).not.toContain("482913");

    expect((await download(bob, transfer.id)).status).toBe(403);
    const wrong = await download(bob, transfer.id, "000000");
    expect(wrong.status).toBe(403);
    expect(await logEvents(transfer.id)).toContain("access_code_failed");
    const right = await download(bob, transfer.id, "482913");
    expect(right.status).toBe(200);
    expect(await right.text()).toBe(content);
    // The submitter is not asked.
    expect((await download(alice, transfer.id)).status).toBe(200);
  });

  it("five wrong codes lock the file for ten minutes, even for the right code", async () => {
    const { alice, bob, reviewer } = await setupOrg();
    const { transfer } = await submit(alice, bob);
    await approve(reviewer, transfer.id, { access_code: "1234" });
    for (let i = 0; i < 5; i++) expect((await download(bob, transfer.id, "9999")).status).toBe(403);
    expect((await download(bob, transfer.id, "1234")).status).toBe(429);
    await env.DB.prepare("UPDATE transfers SET access_code_window_at = ? WHERE id = ?").bind(new Date(Date.now() - 601_000).toISOString(), transfer.id).run();
    expect((await download(bob, transfer.id, "1234")).status).toBe(200);
  });

  it("the browser ticket checks the code when it is issued", async () => {
    const { alice, bob, reviewer } = await setupOrg();
    const { transfer } = await submit(alice, bob);
    await approve(reviewer, transfer.id, { access_code: "55555" });
    const no = await api(`/api/v1/intranet/transfers/${transfer.id}/download-ticket`, { method: "POST", headers: bob.headers, json: { access_code: "11111" } });
    expect(no.status).toBe(403);
    const yes = await json(await api(`/api/v1/intranet/transfers/${transfer.id}/download-ticket`, { method: "POST", headers: bob.headers, json: { access_code: "55555" } }));
    expect((await api(yes.url)).status).toBe(200);
  });

  it("a ticket issued without a code does not bypass one", async () => {
    const { alice, bob, reviewer } = await setupOrg();
    const { transfer } = await submit(alice, bob);
    await approve(reviewer, transfer.id, { access_code: "55555" });
    const { makeDownloadTicket } = await import("../../src/intranet/routes");
    const orgId = (await transferRow(transfer.id))!.organization_id;
    const ticket = await makeDownloadTicket(base(), transfer.id, bob.id, orgId, "transfer");
    expect((await api(`/api/v1/intranet/download/${ticket}`)).status).toBe(403);
  });
});

describe("Jev provider (P2)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("is offered only when JEV_API_KEY is set", async () => {
    const { admin } = await setupOrg();
    const me = await json(await api("/api/v1/intranet/me", { headers: admin.headers }));
    expect(me.agent.jev_configured).toBe(false);
    expect(me.agent.modes).not.toContain("jev");
    expect((await api("/api/v1/intranet/review-settings", { method: "PUT", headers: admin.headers, json: { agent_mode: "jev" } })).status).toBe(422);
  });

  it("never sends content_excerpt, whatever the input mode (AGT-5)", () => {
    const body = jevRequest(withJev(), { purpose: "x", content_excerpt: "secret rows", filename: "a.csv" });
    expect(body.state).not.toHaveProperty("content_excerpt");
    expect(body.model).toBe("typesafe/jev-1.13");
    expect(Object.keys(body.questions)).toEqual(["release", "business_purpose", "file_matches_purpose", "recipient_fit", "no_sensitive_red_flags"]);
  });

  it("reads the release probability and per-criterion answers; a malformed answer is an error", async () => {
    const seen: Request[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      seen.push(new Request(input as string, init));
      return Response.json({
        model: "typesafe/jev-1.13",
        answers: { release: { type: "noul", noul: 0.97 }, business_purpose: { type: "noul", noul: 0.9 } },
      });
    });
    const r = await jevScorer(withJev())({ purpose: "p" });
    expect(r).toMatchObject({ p_approve: 0.97, provider: "jev", model: "typesafe/jev-1.13", version: "1.13" });
    expect(r.reasons).toContain("business_purpose: 0.90");
    expect(r.reasons).toContain("recipient_fit: unjudged");
    expect(seen[0].headers.get("authorization")).toBe("Bearer sk-or-test");

    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ answers: { release: { type: "noul", noul: 1.7 } } }));
    await expect(jevScorer(withJev())({})).rejects.toBeInstanceOf(ScorerError);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("nope", { status: 502 }));
    await expect(jevScorer(withJev())({})).rejects.toThrow(/HTTP 502/);
  });

  it("falls back Jev, then Clef, then a human (AGT-7)", async () => {
    expect(providerChain(withJev(), "jev")).toEqual(["jev", "clef"]);
    const { admin, alice, bob } = await setupOrg();
    await env.DB.prepare("INSERT INTO org_review_settings (organization_id, agent_mode) VALUES (?, 'jev') ON CONFLICT(organization_id) DO UPDATE SET agent_mode = 'jev'")
      .bind((await json(await api("/api/v1/intranet/me", { headers: admin.headers }))).organization.id)
      .run();
    const { transfer } = await submit(alice, bob);
    await waitFor(
      async () => env.DB.prepare("SELECT f.sha256 FROM transfers t JOIN file_assets f ON f.id = t.file_id WHERE t.id = ?").bind(transfer.id).first<{ sha256: string | null }>(),
      (v) => !!v?.sha256,
    );
    await env.DB.prepare("UPDATE transfers SET scan_status = 'clean', agent_window_ends_at = ? WHERE id = ?").bind(new Date(Date.now() - 1000).toISOString(), transfer.id).run();
    const calls: string[] = [];
    const scorers: ScorerFactory = (p) => async (payload) => {
      calls.push(p);
      if (p === "jev") {
        expect(payload).not.toHaveProperty("content_excerpt");
        throw new ScorerError("Jev returned HTTP 503");
      }
      return { p_approve: 0.99, reasons: [], model: "clef", version: "1", provider: "clef" };
    };
    await runPass(env as never, withJev(), scorers);
    expect(calls).toEqual(["jev", "clef"]);
    expect(await transferRow(transfer.id)).toMatchObject({ state: "released", decided_by_id: "agent:clef" });
  });
});
