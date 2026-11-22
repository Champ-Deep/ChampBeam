/**
 * Intranet P0 on the Worker: the BRD section 13 acceptance checklist, plus the invite flow on Better Auth.
 */
import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { runIntranetSweep } from "../../src/intranet/sweep";
import { getSettings } from "../../src/env";
import { intranetCheckSignup } from "../../src/intranet/invites";
import { BASE, api, approve, env, json, logEvents, member, setupOrg, submit, transferRow, waitFor } from "./helpers";
import { createUser, sessionHeaders } from "../helpers";

const sweep = () => runIntranetSweep(env as never, getSettings(env as never));

async function download(m: { headers: Record<string, string> }, id: string, extra: Record<string, string> = {}) {
  return api(`/api/v1/intranet/transfers/${id}/download`, { headers: { ...m.headers, ...extra } });
}

describe("ACC: invite-only access", () => {
  it("Better Auth's own sign-up is switched off", async () => {
    const res = await api("/api/auth/sign-up/email", {
      method: "POST",
      headers: { Origin: BASE },
      json: { email: "stranger@example.com", password: "password-123", name: "Stranger" },
    });
    expect(res.status).toBe(404);
    const row = await env.DB.prepare("SELECT 1 FROM users WHERE email = 'stranger@example.com'").first();
    expect(row).toBeNull();
  });

  it("an uninvited email cannot create an account by any path (ACC-3)", async () => {
    expect(await intranetCheckSignup(env.DB, "nobody@example.com", "/sign-up/email", null)).toMatch(/invitation only/);
    expect(await intranetCheckSignup(env.DB, "nobody@example.com", "/callback/google", null)).toMatch(/invitation only/);
    expect(await intranetCheckSignup(env.DB, "nobody@example.com", null, "nobody@example.com")).toMatch(/invitation only/);
  });

  it("a signed-in user without a membership reaches no intranet route", async () => {
    const outsider = await createUser();
    const headers = await sessionHeaders(outsider.id, null);
    for (const path of ["/api/v1/intranet/me", "/api/v1/intranet/inbox", "/api/v1/intranet/members", "/api/v1/intranet/log"]) {
      const res = await api(path, { headers });
      expect(res.status, path).toBe(403);
    }
  });

  it("unauthenticated requests get 401 and never bytes (NFR-1)", async () => {
    const { alice, bob, reviewer } = await setupOrg();
    const { transfer } = await submit(alice, bob);
    await approve(reviewer, transfer.id);
    for (const path of [
      "/api/v1/intranet/me",
      `/api/v1/intranet/transfers/${transfer.id}/download`,
      `/api/v1/intranet/review/${transfer.id}/file`,
      `/api/v1/intranet/transfers/${transfer.id}`,
      "/api/v1/intranet/log.csv",
    ]) {
      const res = await api(path);
      expect([401, 404], path).toContain(res.status);
      expect(res.headers.get("content-disposition"), path).toBeNull();
    }
    const forged = await api(`/api/v1/intranet/download/${btoa("transfer.x.y.z.9999999999.bad")}`);
    expect(forged.status).toBe(404);
  });

  it("an admin invite creates the account, joins the org with the invited role, and is logged", async () => {
    const { admin, orgId } = await setupOrg();
    const created = await api("/api/v1/intranet/invites", { method: "POST", headers: admin.headers, json: { email: "New.Person@Example.com", is_reviewer: true } });
    expect(created.status).toBe(201);
    const inv = await json(created);
    expect(inv.status).toBe("pending");
    expect(inv.invite_url).toContain("/accept-invite?token=");
    const stored = await env.DB.prepare("SELECT token_hash FROM org_invites WHERE id = ?").bind(inv.id).first<{ token_hash: string }>();
    expect(stored!.token_hash).not.toBe(inv.token);

    const lookup = await json(await api(`/api/v1/intranet/invites/lookup?token=${inv.token}`));
    expect(lookup.email).toBe("new.person@example.com");

    const short = await api("/api/v1/intranet/invites/accept", { method: "POST", headers: { Origin: BASE }, json: { token: inv.token, name: "New", password: "short" } });
    expect(short.status).toBe(422);
    const ok = await api("/api/v1/intranet/invites/accept", { method: "POST", headers: { Origin: BASE }, json: { token: inv.token, name: "New Person", password: "a-long-password-1" } });
    expect(ok.status).toBe(200);
    const cookie = ok.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("champbeam.session_token");

    const m = await env.DB.prepare(
      "SELECT m.role, m.is_reviewer FROM organization_memberships m JOIN users u ON u.id = m.user_id WHERE u.email = 'new.person@example.com' AND m.organization_id = ?",
    )
      .bind(orgId)
      .first<{ role: string; is_reviewer: number }>();
    expect(m).toEqual({ role: "member", is_reviewer: 1 });

    const me = await api("/api/v1/intranet/me", { headers: { Cookie: cookie.split(";")[0], Origin: BASE } });
    expect(me.status).toBe(200);
    expect((await json(me)).is_reviewer).toBe(true);

    // A used invite cannot be replayed.
    const again = await api("/api/v1/intranet/invites/accept", { method: "POST", headers: { Origin: BASE }, json: { token: inv.token, name: "X", password: "a-long-password-1" } });
    expect(again.status).toBe(410);
    const events = await env.DB.prepare("SELECT event FROM decision_log WHERE organization_id = ? AND transfer_id IS NULL ORDER BY id").bind(orgId).all<{ event: string }>();
    expect(events.results.map((r) => r.event)).toEqual(["member_invited", "invite_accepted"]);
  });

  it("invites expire after 7 days and can be revoked (ACC-2)", async () => {
    const { admin } = await setupOrg();
    const inv = await json(await api("/api/v1/intranet/invites", { method: "POST", headers: admin.headers, json: { email: "late@example.com" } }));
    expect(Date.parse(inv.expires_at) - Date.parse(inv.created_at)).toBeGreaterThan(6.9 * 86_400_000);
    const revoked = await json(await api(`/api/v1/intranet/invites/${inv.id}`, { method: "DELETE", headers: admin.headers }));
    expect(revoked.status).toBe("revoked");
    const accept = await api("/api/v1/intranet/invites/accept", { method: "POST", headers: { Origin: BASE }, json: { token: inv.token, name: "Late", password: "a-long-password-1" } });
    expect(accept.status).toBe(410);

    const inv2 = await json(await api("/api/v1/intranet/invites", { method: "POST", headers: admin.headers, json: { email: "later@example.com" } }));
    await env.DB.prepare("UPDATE org_invites SET expires_at = ? WHERE id = ?").bind(new Date(Date.now() - 1000).toISOString(), inv2.id).run();
    expect(await intranetCheckSignup(env.DB, "later@example.com", null, "later@example.com")).toMatch(/invitation only/);
    await sweep();
    const row = await env.DB.prepare("SELECT revoked_at FROM org_invites WHERE id = ?").bind(inv2.id).first<{ revoked_at: string | null }>();
    expect(row!.revoked_at).not.toBeNull();
  });

  it("only admins invite; deactivation takes effect on the next request (ACC-4); admin assigns roles (ACC-5)", async () => {
    const { admin, alice, bob } = await setupOrg();
    const denied = await api("/api/v1/intranet/invites", { method: "POST", headers: alice.headers, json: { email: "x@example.com" } });
    expect(denied.status).toBe(403);

    const promote = await api(`/api/v1/intranet/members/${bob.id}`, { method: "PATCH", headers: admin.headers, json: { is_reviewer: true, role: "admin" } });
    expect(promote.status).toBe(200);
    expect(await json(promote)).toMatchObject({ is_reviewer: true, is_admin: true });

    expect((await api("/api/v1/intranet/me", { headers: alice.headers })).status).toBe(200);
    const off = await api(`/api/v1/intranet/members/${alice.id}`, { method: "PATCH", headers: admin.headers, json: { active: false } });
    expect((await json(off)).active).toBe(false);
    expect((await api("/api/v1/intranet/me", { headers: alice.headers })).status).toBe(401);
    // Even a session that survived (re-created here) is refused by the membership check.
    expect((await api("/api/v1/intranet/me", { headers: await sessionHeaders(alice.id, (await json(await api("/api/v1/intranet/me", { headers: admin.headers }))).organization.id) })).status).toBe(403);
    const self = await api(`/api/v1/intranet/members/${admin.id}`, { method: "PATCH", headers: admin.headers, json: { active: false } });
    expect(self.status).toBe(400);
  });
});

describe("SUB / REV / REL: the review gate", () => {
  it("an unapproved file is refused to the recipient and every other member (SUB-2)", async () => {
    const { alice, bob, admin } = await setupOrg();
    const { transfer } = await submit(alice, bob);
    expect(transfer.state).toBe("submitted");
    expect((await download(bob, transfer.id)).status).toBe(403);
    expect([403, 404]).toContain((await download(admin, transfer.id)).status);
    expect(await json(await api("/api/v1/intranet/inbox", { headers: bob.headers }))).toEqual([]);
    expect((await api(`/api/v1/intranet/transfers/${transfer.id}`, { headers: bob.headers })).status).toBe(403);
    expect((await api(`/api/v1/intranet/review/${transfer.id}/file`, { headers: admin.headers })).status).toBe(403);
  });

  it("records name, size, MIME, sha256, submitter, recipient, purpose and time (SUB-3)", async () => {
    const { alice, bob } = await setupOrg();
    const { transfer, content } = await submit(alice, bob, { filename: "q3.csv" });
    expect(transfer).toMatchObject({ filename: "q3.csv", size_bytes: content.length, mime_type: "text/csv", purpose: "Monthly data drop for the finance team" });
    expect(transfer.submitter.user_id).toBe(alice.id);
    expect(transfer.recipient.user_id).toBe(bob.id);
    expect(transfer.submitted_at).toBeTruthy();
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const t = await waitFor(
      async () => json(await api(`/api/v1/intranet/transfers/${transfer.id}`, { headers: alice.headers })),
      (v: any) => !!v.sha256,
    );
    expect(t.sha256).toBe(hex);
  });

  it("hard checks refuse blocked types and empty files, and log the failure without the name (SUB-5)", async () => {
    const { alice, orgId } = await setupOrg();
    const res = await api("/api/v1/intranet/uploads", { method: "POST", headers: alice.headers, json: { filename: "tool.EXE", content_type: "application/octet-stream", size_bytes: 10 } });
    expect(res.status).toBe(422);
    expect((await json(res)).detail.failures[0]).toMatch(/Blocked file type: \.exe/);
    const row = await env.DB.prepare("SELECT reason, detail FROM decision_log WHERE organization_id = ? AND event = 'check_failed'").bind(orgId).first<{ reason: string; detail: string }>();
    expect(row!.detail).not.toContain("tool");
    const big = await api("/api/v1/intranet/uploads", { method: "POST", headers: alice.headers, json: { filename: "x.csv", content_type: "text/csv", size_bytes: 200 * 1024 * 1024 } });
    expect(big.status).toBe(422);
  });

  it("the submitter's requested limits can only be tightened (SUB-4)", async () => {
    const { alice, bob, reviewer } = await setupOrg();
    const { transfer } = await submit(alice, bob, { days: 3, oneTime: true });
    expect((await approve(reviewer, transfer.id, { expires_in_days: 5 })).status).toBe(422);
    expect((await approve(reviewer, transfer.id, { one_time: false })).status).toBe(422);
    const ok = await approve(reviewer, transfer.id, { expires_in_days: 1 });
    expect(ok.status).toBe(200);
    const t = await json(ok);
    expect(t.one_time).toBe(true);
    expect(Date.parse(t.expires_at) - Date.parse(t.released_at)).toBe(86_400_000);
  });

  it("the queue is oldest first, with age and agent window (REV-1), and opening a file is logged (REV-2)", async () => {
    const { alice, bob, reviewer } = await setupOrg();
    const first = (await submit(alice, bob)).transfer;
    const second = (await submit(bob, alice)).transfer;
    await env.DB.prepare("UPDATE transfers SET submitted_at = ? WHERE id = ?").bind(new Date(Date.now() - 3_600_000).toISOString(), first.id).run();
    const queue = await json(await api("/api/v1/intranet/review/queue", { headers: reviewer.headers }));
    expect(queue.map((t: any) => t.id)).toEqual([first.id, second.id]);
    expect(queue[0].age_seconds).toBeGreaterThanOrEqual(3599);
    expect(queue[0].agent_window_ends_at).toBeTruthy();
    const badges = await json(await api("/api/v1/intranet/badges", { headers: reviewer.headers }));
    expect(badges.review_queue).toBe(2);

    const file = await api(`/api/v1/intranet/review/${first.id}/file`, { headers: reviewer.headers });
    expect(file.status).toBe(200);
    expect(await file.text()).toContain("report");
    expect((await transferRow(first.id))!.state).toBe("in_review");
    expect(await logEvents(first.id)).toContain("opened_for_review");
  });

  it("a Reviewer cannot decide their own submission (REV-4)", async () => {
    const { reviewer, alice } = await setupOrg();
    const { transfer } = await submit(reviewer, alice);
    expect((await approve(reviewer, transfer.id)).status).toBe(403);
    const rej = await api(`/api/v1/intranet/review/${transfer.id}/reject`, { method: "POST", headers: reviewer.headers, json: { reason: "no" } });
    expect(rej.status).toBe(403);
  });

  it("reject without a reason is refused; with one the reason reaches the submitter and the blob goes (REV-3)", async () => {
    const { alice, bob, reviewer } = await setupOrg();
    const { transfer, fileId } = await submit(alice, bob);
    for (const body of [{}, { reason: "" }, { reason: "   " }]) {
      const r = await api(`/api/v1/intranet/review/${transfer.id}/reject`, { method: "POST", headers: reviewer.headers, json: body });
      expect(r.status).toBe(422);
    }
    const r = await api(`/api/v1/intranet/review/${transfer.id}/reject`, { method: "POST", headers: reviewer.headers, json: { reason: "Contains customer PII" } });
    expect(r.status).toBe(200);
    const mine = await json(await api("/api/v1/intranet/transfers/mine", { headers: alice.headers }));
    expect(mine[0]).toMatchObject({ state: "rejected", receipt: "rejected", reject_reason: "Contains customer PII" });
    const asset = await env.DB.prepare("SELECT status, storage_key FROM file_assets WHERE id = ?").bind(fileId).first<{ status: string; storage_key: string }>();
    expect(asset!.status).toBe("deleted");
    await waitFor(async () => env.FILES.head(asset!.storage_key), (v) => v === null);
  });

  it("approval releases to the recipient's inbox with an Opened receipt (REL-1, REL-2, REL-6)", async () => {
    const { alice, bob, reviewer, admin } = await setupOrg();
    const { transfer, content } = await submit(alice, bob);
    expect((await approve(reviewer, transfer.id)).status).toBe(200);
    let mine = await json(await api("/api/v1/intranet/transfers/mine", { headers: alice.headers }));
    expect(mine[0].receipt).toBe("not_opened");
    const inbox = await json(await api("/api/v1/intranet/inbox", { headers: bob.headers }));
    expect(inbox.map((t: any) => t.id)).toEqual([transfer.id]);
    expect((await download(admin, transfer.id)).status).toBe(403);

    const res = await download(bob, transfer.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe(content);
    mine = await waitFor(
      async () => json(await api("/api/v1/intranet/transfers/mine", { headers: alice.headers })),
      (v: any) => v[0].receipt === "opened",
    );
    expect(mine[0].receipt).toBe("opened");
    expect(mine[0].first_opened_at).toBeTruthy();
  });

  it("ten parallel downloads of a one-time file yield exactly one success (REL-4)", async () => {
    const { alice, bob, reviewer } = await setupOrg();
    const { transfer, content } = await submit(alice, bob, { oneTime: true });
    await approve(reviewer, transfer.id);
    const results = await Promise.all(Array.from({ length: 10 }, () => download(bob, transfer.id)));
    const ok = results.filter((r) => r.status === 200);
    expect(ok.length).toBe(1);
    // The rest are told it is being downloaded (409) or, once the winner finished, already consumed (410).
    expect(results.filter((r) => r.status !== 200).every((r) => r.status === 409 || r.status === 410)).toBe(true);
    expect(await ok[0].text()).toBe(content);
    const row = await waitFor(() => transferRow(transfer.id), (v) => v!.state === "consumed");
    expect(row!.state).toBe("consumed");
    expect((await download(bob, transfer.id)).status).toBe(410);
    expect(await logEvents(transfer.id)).toEqual(expect.arrayContaining(["opened_by_recipient", "consumed"]));
  });

  it("an interrupted one-time download releases its claim and can be retried", async () => {
    const { alice, bob, reviewer } = await setupOrg();
    const { transfer, content } = await submit(alice, bob, { oneTime: true, content: "x".repeat(200_000) });
    await approve(reviewer, transfer.id);
    const first = await download(bob, transfer.id);
    expect(first.status).toBe(200);
    await first.body!.cancel();
    await waitFor(() => transferRow(transfer.id), (v) => v!.download_claim_token === null);
    const retry = await download(bob, transfer.id);
    expect(retry.status).toBe(200);
    expect((await retry.text()).length).toBe(content.length);
  });

  it("after expires_at the file is refused, and the sweep removes the blob (REL-3)", async () => {
    const { alice, bob, reviewer } = await setupOrg();
    const { transfer, fileId } = await submit(alice, bob);
    await approve(reviewer, transfer.id);
    await env.DB.prepare("UPDATE transfers SET expires_at = ? WHERE id = ?").bind(new Date(Date.now() - 1000).toISOString(), transfer.id).run();
    const res = await download(bob, transfer.id);
    expect(res.status).toBe(410);
    const key = (await env.DB.prepare("SELECT storage_key FROM file_assets WHERE id = ?").bind(fileId).first<{ storage_key: string }>())!.storage_key;
    expect(await env.FILES.head(key)).not.toBeNull();
    await sweep();
    expect((await transferRow(transfer.id))!.state).toBe("expired");
    expect(await env.FILES.head(key)).toBeNull();
    const mine = await json(await api("/api/v1/intranet/transfers/mine", { headers: alice.headers }));
    expect(mine[0].receipt).toBe("expired");
    expect(await logEvents(transfer.id)).toContain("expired");
  });

  it("an undecided submission expires at the hard expiry", async () => {
    const { alice, bob } = await setupOrg();
    const { transfer } = await submit(alice, bob);
    await env.DB.prepare("UPDATE transfers SET hard_expires_at = ? WHERE id = ?").bind(new Date(Date.now() - 1000).toISOString(), transfer.id).run();
    await sweep();
    expect((await transferRow(transfer.id))!.state).toBe("expired");
  });

  it("a revoked file is refused at once (REL-5), by submitter or Reviewer only", async () => {
    const { alice, bob, reviewer } = await setupOrg();
    const { transfer } = await submit(alice, bob);
    await approve(reviewer, transfer.id);
    expect((await api(`/api/v1/intranet/transfers/${transfer.id}/revoke`, { method: "POST", headers: bob.headers })).status).toBe(403);
    const r = await api(`/api/v1/intranet/transfers/${transfer.id}/revoke`, { method: "POST", headers: alice.headers, json: { reason: "wrong file" } });
    expect(r.status).toBe(200);
    expect((await json(r)).receipt).toBe("revoked");
    expect((await download(bob, transfer.id)).status).toBe(410);
  });

  it("browser downloads use a short-lived ticket bound to the user", async () => {
    const { alice, bob, reviewer } = await setupOrg();
    const { transfer, content } = await submit(alice, bob);
    await approve(reviewer, transfer.id);
    const t = await json(await api(`/api/v1/intranet/transfers/${transfer.id}/download-ticket`, { method: "POST", headers: bob.headers }));
    const res = await SELF.fetch(`${BASE}${t.url}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(content);
    const tampered = t.url.slice(0, -3) + "AAA";
    expect((await SELF.fetch(`${BASE}${tampered}`)).status).toBe(404);
    // Cross-site POSTs carrying the session cookie are refused.
    const xsite = await api(`/api/v1/intranet/transfers/${transfer.id}/download-ticket`, { method: "POST", headers: { ...bob.headers, Origin: "https://evil.example" } });
    expect(xsite.status).toBe(403);
  });
});

describe("7.1: the decision log", () => {
  it("every state change wrote a row, the chain verifies, and nothing can edit or delete a row", async () => {
    const { alice, bob, reviewer, orgId } = await setupOrg();
    const { transfer } = await submit(alice, bob, { oneTime: true });
    await api(`/api/v1/intranet/review/${transfer.id}/file`, { headers: reviewer.headers }).then((r) => r.text());
    await approve(reviewer, transfer.id);
    await (await download(bob, transfer.id)).text();
    await waitFor(() => transferRow(transfer.id), (v) => v!.state === "consumed");
    expect(await logEvents(transfer.id)).toEqual(["submitted", "scanned", "opened_for_review", "approved", "released", "opened_by_recipient", "consumed"]);

    const v = await json(await api("/api/v1/intranet/log/verify", { headers: reviewer.headers }));
    expect(v.ok).toBe(true);

    await expect(env.DB.prepare("UPDATE decision_log SET reason = 'x' WHERE organization_id = ?").bind(orgId).run()).rejects.toThrow(/append-only/);
    await expect(env.DB.prepare("DELETE FROM decision_log WHERE organization_id = ?").bind(orgId).run()).rejects.toThrow(/append-only/);

    for (const method of ["PUT", "PATCH", "DELETE", "POST"]) {
      const r = await api("/api/v1/intranet/log", { method, headers: reviewer.headers, json: {} });
      expect(r.status, method).toBe(404);
    }
    const first = await json(await api("/api/v1/intranet/log?limit=1", { headers: reviewer.headers }));
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const r = await api(`/api/v1/intranet/log/${first.items[0].id}`, { method, headers: reviewer.headers, json: {} });
      expect(r.status, method).toBe(404);
    }
  });

  it("filters by event and actor, exports CSV, and is closed to plain members", async () => {
    const { alice, bob, reviewer } = await setupOrg();
    const { transfer } = await submit(alice, bob);
    await approve(reviewer, transfer.id);
    expect((await api("/api/v1/intranet/log", { headers: alice.headers })).status).toBe(403);
    const approved = await json(await api(`/api/v1/intranet/log?event=approved&actor_id=${reviewer.id}`, { headers: reviewer.headers }));
    expect(approved.total).toBe(1);
    expect(approved.items[0]).toMatchObject({ event: "approved", actor_name: "Rita Reviewer" });
    const csv = await api("/api/v1/intranet/log.csv", { headers: reviewer.headers });
    expect(csv.headers.get("content-type")).toContain("text/csv");
    const text = await csv.text();
    expect(text.split("\r\n")[0]).toBe("id,at,transfer_id,event,actor_type,actor_id,actor_name,reason,agent_provider,agent_model,agent_input_mode,agent_p_approve,agent_threshold,agent_input_sha256,prev_hash,row_hash");
    expect(text).toContain(",approved,");
  });

  it("concurrent writers keep one linear chain", async () => {
    const { alice, bob, reviewer } = await setupOrg();
    const subs = await Promise.all(Array.from({ length: 6 }, () => submit(alice, bob)));
    await Promise.all(subs.map((s) => approve(reviewer, s.transfer.id)));
    const v = await json(await api("/api/v1/intranet/log/verify", { headers: reviewer.headers }));
    expect(v.ok).toBe(true);
    expect(v.rows).toBe(6 * 4);
  });
});

describe("INTRANET_MODE gate", () => {
  it("marketing and public routes are not served", async () => {
    const { alice } = await setupOrg();
    for (const path of ["/api/v1/files", "/api/v1/utm/links", "/api/v1/pages", "/api/v1/rooms", "/api/v1/org/members"]) {
      const res = await api(path, { headers: alice.headers });
      expect(res.status, path).toBe(404);
    }
    const r = await api("/r/abc123");
    expect(r.status).not.toBe(302);
    expect((await api("/health")).status).toBe(200);
  });

  it("a member cannot submit to someone outside the org or a deactivated member", async () => {
    const { alice, bob, admin } = await setupOrg();
    const other = await setupOrg();
    await expect(submit(alice, other.bob)).rejects.toThrow(/submit 400/);
    await api(`/api/v1/intranet/members/${bob.id}`, { method: "PATCH", headers: admin.headers, json: { active: false } });
    await expect(submit(alice, bob)).rejects.toThrow(/submit 400/);
    const m = await member(other.orgId);
    expect((await api("/api/v1/intranet/members", { headers: m.headers })).status).toBe(200);
  });
});
