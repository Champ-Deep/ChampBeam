/**
 * Intranet P1 on the Worker: malware scan, withdraw, reminders, review agent (local scorer), overturn, benchmark.
 */
import { describe, expect, it } from "vitest";
import { getSettings } from "../../src/env";
import { applyScanResult, parseReply, scanTransfer } from "../../src/intranet/scan";
import { runPass, ScorerError, type ScorerFactory } from "../../src/intranet/reviewAgent";
import { runJob } from "../../src/intranet/benchmark";
import { runIntranetSweep } from "../../src/intranet/sweep";
import { verifyChain } from "../../src/intranet/decisionLog";
import { api, approve, env, json, logEvents, setupOrg, submit, transferRow, waitFor } from "./helpers";

const settings = () => getSettings(env as never);
const E = env as never;

async function enableAgent(admin: { headers: Record<string, string> }, extra: Record<string, unknown> = {}) {
  const r = await api("/api/v1/intranet/review-settings", { method: "PUT", headers: admin.headers, json: { agent_mode: "local", ...extra } });
  expect(r.status).toBe(200);
}

/** A transfer that passed every deterministic check and whose wait window has passed. */
async function due(t: { id: string }, opts: { scan?: string } = {}) {
  await waitFor(() => transferRow(t.id), (v) => true);
  await waitFor(
    async () => env.DB.prepare("SELECT f.sha256 FROM transfers t JOIN file_assets f ON f.id = t.file_id WHERE t.id = ?").bind(t.id).first<{ sha256: string | null }>(),
    (v) => !!v?.sha256,
  );
  await env.DB.prepare("UPDATE transfers SET scan_status = ?, agent_window_ends_at = ? WHERE id = ?")
    .bind(opts.scan ?? "clean", new Date(Date.now() - 60_000).toISOString(), t.id)
    .run();
}

const scorers = (p: number | Error): ScorerFactory => () => async () => {
  if (p instanceof Error) throw p;
  return { p_approve: p, reasons: ["fixed"], model: "fixed", version: "1", provider: "clef" };
};

describe("SUB-5: malware scan", () => {
  it("parses clamd replies", () => {
    expect(parseReply("stream: OK\0").status).toBe("clean");
    expect(parseReply("stream: Eicar-Signature FOUND\0")).toEqual({ status: "infected", detail: "clamd: Eicar-Signature" });
    expect(parseReply("INSTREAM size limit exceeded. ERROR").status).toBe("not_scanned");
    expect(parseReply("").status).toBe("not_scanned");
  });

  it("an infected file is refused, its blob deleted and both steps logged", async () => {
    const { alice, bob } = await setupOrg();
    const { transfer, fileId } = await submit(alice, bob);
    await env.DB.prepare("UPDATE transfers SET state = 'scanning', scan_status = 'pending' WHERE id = ?").bind(transfer.id).run();
    await scanTransfer(E, settings(), transfer.id, async () => ({ status: "infected", detail: "clamd: Eicar" }));
    const row = await transferRow(transfer.id);
    expect(row).toMatchObject({ state: "check_failed", scan_status: "infected" });
    const f = await env.DB.prepare("SELECT status, storage_key FROM file_assets WHERE id = ?").bind(fileId).first<{ status: string; storage_key: string }>();
    expect(f!.status).toBe("deleted");
    expect(await env.FILES.head(f!.storage_key)).toBeNull();
    expect(await logEvents(transfer.id)).toEqual(expect.arrayContaining(["scanned", "check_failed"]));
  });

  it("a clean verdict moves the file into the queue; reviewers do not see files still scanning", async () => {
    const { alice, bob, reviewer } = await setupOrg();
    const { transfer } = await submit(alice, bob);
    await env.DB.prepare("UPDATE transfers SET state = 'scanning', scan_status = 'pending' WHERE id = ?").bind(transfer.id).run();
    expect(await json(await api("/api/v1/intranet/review/queue", { headers: reviewer.headers }))).toEqual([]);
    expect(await applyScanResult(env.DB, transfer.id, { status: "clean", detail: "clamd: OK" })).toBeNull();
    const queue = await json(await api("/api/v1/intranet/review/queue", { headers: reviewer.headers }));
    expect(queue.map((t: any) => t.scan_status)).toEqual(["clean"]);
  });

  it("without a scanner the file is queued and flagged not scanned", async () => {
    const { alice, bob } = await setupOrg();
    const { transfer } = await submit(alice, bob);
    expect(transfer).toMatchObject({ state: "submitted", scan_status: "not_scanned" });
    const me = await json(await api("/api/v1/intranet/me", { headers: alice.headers }));
    expect(me.malware_scan).toBe(false);
  });
});

describe("SUB-6 withdraw and REV-6 reminders", () => {
  it("the submitter withdraws an unreleased submission; nobody else can; a released one cannot be withdrawn", async () => {
    const { alice, bob, reviewer } = await setupOrg();
    const a = (await submit(alice, bob)).transfer;
    expect((await api(`/api/v1/intranet/transfers/${a.id}/withdraw`, { method: "POST", headers: bob.headers })).status).toBe(403);
    const ok = await api(`/api/v1/intranet/transfers/${a.id}/withdraw`, { method: "POST", headers: alice.headers, json: { reason: "sent the wrong file" } });
    expect(ok.status).toBe(200);
    expect((await json(ok)).state).toBe("withdrawn");
    const b = (await submit(alice, bob)).transfer;
    await approve(reviewer, b.id);
    expect((await api(`/api/v1/intranet/transfers/${b.id}/withdraw`, { method: "POST", headers: alice.headers })).status).toBe(409);
  });

  it("a submission waiting past reminder_hours gets one reminder row and shows as overdue", async () => {
    const { alice, bob, reviewer } = await setupOrg();
    const { transfer } = await submit(alice, bob);
    await env.DB.prepare("UPDATE transfers SET submitted_at = ? WHERE id = ?").bind(new Date(Date.now() - 13 * 3_600_000).toISOString(), transfer.id).run();
    await runIntranetSweep(E, settings());
    await runIntranetSweep(E, settings());
    expect((await logEvents(transfer.id)).filter((e) => e === "reminder_sent")).toHaveLength(1);
    const badges = await json(await api("/api/v1/intranet/badges", { headers: reviewer.headers }));
    expect(badges.review_overdue).toBe(1);
  });
});

describe("AGT: the review agent", () => {
  it("is off by default; only admins can switch it on and every change is logged (AGT-1)", async () => {
    const { admin, reviewer, orgId } = await setupOrg();
    expect((await json(await api("/api/v1/intranet/review-settings", { headers: admin.headers }))).agent_mode).toBe("off");
    expect((await api("/api/v1/intranet/review-settings", { method: "PUT", headers: reviewer.headers, json: { agent_mode: "local" } })).status).toBe(403);
    expect((await api("/api/v1/intranet/review-settings", { method: "PUT", headers: admin.headers, json: { agent_mode: "jev" } })).status).toBe(422);
    await enableAgent(admin);
    const row = await env.DB.prepare("SELECT detail FROM decision_log WHERE organization_id = ? AND event = 'settings_changed'").bind(orgId).first<{ detail: string }>();
    expect(JSON.parse(row!.detail).changes.agent_mode).toEqual(["off", "local"]);
  });

  it("never acts before the wait window (AGT-2)", async () => {
    const { admin, alice, bob } = await setupOrg();
    await enableAgent(admin);
    const { transfer } = await submit(alice, bob);
    await env.DB.prepare("UPDATE transfers SET scan_status = 'clean' WHERE id = ?").bind(transfer.id).run();
    await runPass(E, settings(), scorers(0.99));
    expect((await transferRow(transfer.id))!.state).toBe("submitted");
  });

  it("deterministic checks run first: not scanned or duplicate escalates without scoring (AGT-3)", async () => {
    const { admin, alice, bob } = await setupOrg();
    await enableAgent(admin);
    const { transfer } = await submit(alice, bob);
    await due(transfer, { scan: "not_scanned" });
    let called = false;
    await runPass(E, settings(), () => async () => {
      called = true;
      throw new Error("must not run");
    });
    expect(called).toBe(false);
    const row = await transferRow(transfer.id);
    expect(row!.state).toBe("submitted");
    expect(row!.escalation_reason).toMatch(/malware scan is 'not_scanned'/);

    const dupContent = "same bytes twice";
    const one = await submit(alice, bob, { content: dupContent });
    const two = await submit(alice, bob, { content: dupContent });
    await due(two.transfer);
    await runPass(E, settings(), scorers(0.99));
    expect((await transferRow(two.transfer.id))!.escalation_reason).toMatch(/submitted before/);
    void one;
  });

  it("approves at or above the threshold with a fully logged agent row, and escalates below it (AGT-4, AGT-6)", async () => {
    const { admin, alice, bob, reviewer } = await setupOrg();
    await enableAgent(admin, { agent_threshold: 0.9 });
    const hi = (await submit(alice, bob)).transfer;
    const lo = (await submit(alice, bob)).transfer;
    await due(hi);
    await due(lo);
    let n = 0;
    const s = await runPass(E, settings(), () => async () => ({ p_approve: n++ === 0 ? 0.95 : 0.5, reasons: ["r"], model: "clef-small", version: "3", provider: "clef" }));
    expect(s).toMatchObject({ approved: 1, escalated: 1 });
    const approved = await transferRow(hi.id);
    expect(approved).toMatchObject({ state: "released", decided_by_type: "agent", decided_by_id: "agent:clef" });
    const row = await env.DB.prepare("SELECT * FROM decision_log WHERE transfer_id = ? AND event = 'approved'").bind(hi.id).first<any>();
    expect(row).toMatchObject({ actor_type: "agent", actor_id: "agent:clef", agent_provider: "clef", agent_model: "clef-small@3", agent_input_mode: "metadata_only", agent_p_approve: 0.95, agent_threshold: 0.9 });
    expect(row.agent_input_sha256).toMatch(/^[0-9a-f]{64}$/);
    const below = await transferRow(lo.id);
    expect(below!.state).toBe("submitted");
    expect(below!.escalation_reason).toMatch(/below the 0.90 threshold/);
    const badges = await json(await api("/api/v1/intranet/badges", { headers: reviewer.headers }));
    expect(badges.review_overdue).toBe(1);
    // Escalated items are not re-scored.
    await runPass(E, settings(), scorers(0.99));
    expect((await transferRow(lo.id))!.state).toBe("submitted");
  });

  it("a scorer error or bad answer is never approval (AGT-7)", async () => {
    const { admin, alice, bob } = await setupOrg();
    await enableAgent(admin);
    const a = (await submit(alice, bob)).transfer;
    await due(a);
    await runPass(E, settings(), scorers(new ScorerError("Clef returned HTTP 500")));
    expect(await transferRow(a.id)).toMatchObject({ state: "submitted" });
    expect((await transferRow(a.id))!.escalation_reason).toMatch(/Scorer unavailable/);
    const b = (await submit(alice, bob)).transfer;
    await due(b);
    await runPass(E, settings(), scorers(new TypeError("boom")));
    expect((await transferRow(b.id))!.state).toBe("submitted");
  });

  it("a Reviewer can overturn an agent approval until the recipient opens the file (AGT-8)", async () => {
    const { admin, alice, bob, reviewer } = await setupOrg();
    await enableAgent(admin);
    const a = (await submit(alice, bob)).transfer;
    const b = (await submit(alice, bob)).transfer;
    await due(a);
    await due(b);
    await runPass(E, settings(), scorers(0.99));
    const listed = await json(await api("/api/v1/intranet/review/agent-approved", { headers: reviewer.headers }));
    expect(listed.map((t: any) => t.id).sort()).toEqual([a.id, b.id].sort());
    expect((await api(`/api/v1/intranet/review/${a.id}/overturn`, { method: "POST", headers: reviewer.headers, json: { reason: "" } })).status).toBe(422);
    const o = await api(`/api/v1/intranet/review/${a.id}/overturn`, { method: "POST", headers: reviewer.headers, json: { reason: "Not for Bob" } });
    expect(o.status).toBe(200);
    expect(await json(o)).toMatchObject({ state: "rejected", reject_reason: "Not for Bob" });
    await (await api(`/api/v1/intranet/transfers/${b.id}/download`, { headers: bob.headers })).text();
    await waitFor(() => transferRow(b.id), (v) => !!v!.first_opened_at);
    expect((await api(`/api/v1/intranet/review/${b.id}/overturn`, { method: "POST", headers: reviewer.headers, json: { reason: "late" } })).status).toBe(409);
  });

  it("an undecided submission expires at the hard expiry and the submitter sees it (AGT-9)", async () => {
    const { alice, bob } = await setupOrg();
    const { transfer } = await submit(alice, bob);
    await env.DB.prepare("UPDATE transfers SET hard_expires_at = ? WHERE id = ?").bind(new Date(Date.now() - 1).toISOString(), transfer.id).run();
    await runIntranetSweep(E, settings());
    const mine = await json(await api("/api/v1/intranet/transfers/mine", { headers: alice.headers }));
    expect(mine[0].state).toBe("expired");
  });
});

describe("benchmark", () => {
  it("replays human decisions and reports agreement without a pass mark", async () => {
    const { admin, alice, bob, reviewer, orgId } = await setupOrg();
    const good = (await submit(alice, bob, { purpose: "Quarterly revenue file for finance" })).transfer;
    const bad = (await submit(alice, bob, { purpose: "please reject me" })).transfer;
    await approve(reviewer, good.id);
    await api(`/api/v1/intranet/review/${bad.id}/reject`, { method: "POST", headers: reviewer.headers, json: { reason: "no purpose" } });
    expect((await api("/api/v1/intranet/agent/benchmarks", { method: "POST", headers: reviewer.headers, json: { provider: "mock" } })).status).toBe(403);
    const started = await api("/api/v1/intranet/agent/benchmarks", { method: "POST", headers: admin.headers, json: { provider: "mock" } });
    expect(started.status).toBe(202);
    const { id } = await json(started);
    await runJob(E, settings(), id);
    const list = await json(await api("/api/v1/intranet/agent/benchmarks", { headers: admin.headers }));
    const b = list.find((x: any) => x.id === id);
    expect(b.status).toBe("done");
    expect(b.report).toMatchObject({ cases: 2, scored: 2, human_approved: 1, human_rejected: 1 });
    expect(b.report.at_current_threshold.agreement).toBe(1);
    expect(b.markdown).toContain("| Threshold | Agreement");
    expect(b.report).not.toHaveProperty("pass");
    expect((await verifyChain(env.DB, orgId)).ok).toBe(true);
  });
});
