/**
 * Delegated reporting: viewer grants, scoped summary, profile context and org
 * domain administration. Fixtures: migrated in-memory D1 + test-signed Clerk
 * JWTs; no live Clerk. The point under test is that a viewer reads reports and
 * can do nothing else, and that scope is recomputed from D1 on every request.
 */
import { describe, expect, it } from "vitest";
import { api, apiKeyHeaders, bearer, clerkToken, createApiKey, createUser, env, json } from "./helpers";
import { addClicks, member, newOrgId, seedTeam, useRouteTestHooks } from "./orgTestUtils";
import { iso, row, seedDomain, seedFile, seedLink } from "./serveSeed";

useRouteTestHooks();

const orgUuid = async (clerkOrgId: string) =>
  (await row<{ id: string }>("SELECT id FROM organizations WHERE clerk_org_id = ?", clerkOrgId))!.id;

const grant = (admin: { headers: Record<string, string> }, body: object) =>
  api("/api/v1/org/viewers", { method: "POST", headers: admin.headers, json: body });
const summary = (who: { headers: Record<string, string> }, qs = "") =>
  api(`/api/v1/org/reporting/summary${qs}`, { headers: who.headers });

async function addFileViews(fileId: string, n: number) {
  for (let i = 0; i < n; i++) {
    await env.DB.prepare("INSERT INTO click_events (id, file_id, ip_address, is_revisit, is_vpn, clicked_at) VALUES (?,?,?,0,0,?)")
      .bind(crypto.randomUUID(), fileId, `9.9.9.${i}`, iso())
      .run();
  }
}

/** rep1: 1 hosted page (3 opens) + 1 download file (1 open) + 1 link (2 clicks). rep2: 1 hosted page (4 opens). */
async function seedActivity(t: Awaited<ReturnType<typeof seedTeam>>) {
  const o = await orgUuid(t.org);
  const page1 = await seedFile(t.rep1.userId, { kind: "html", mime: "text/html", slug: `p1-${crypto.randomUUID().slice(0, 6)}`, organization_id: o, share_intent: "host" });
  const file1 = await seedFile(t.rep1.userId, { organization_id: o, share_intent: "download" });
  const page2 = await seedFile(t.rep2.userId, { kind: "html", mime: "text/html", slug: `p2-${crypto.randomUUID().slice(0, 6)}`, organization_id: o, share_intent: "host" });
  const link1 = await seedLink(t.rep1.userId, `l${crypto.randomUUID().slice(0, 6)}`, { organization_id: o });
  await addFileViews(page1.id, 3);
  await addFileViews(file1.id, 1);
  await addFileViews(page2.id, 4);
  await addClicks(link1, ["1.1.1.1", "1.1.1.2"]);
  return o;
}

describe("viewer grants", () => {
  it("only an org admin manages grants; leader and member are refused", async () => {
    const t = await seedTeam();
    const viewer = await member(t.org, "viewer");
    const body = { user_id: viewer.userId, scope: "org" };
    for (const who of [t.leader, t.rep1, viewer]) expect((await grant(who, body)).status).toBe(403);
    expect((await api("/api/v1/org/viewers", { headers: t.leader.headers })).status).toBe(403);
    const ok = await grant(t.admin, body);
    expect(ok.status).toBe(201);
    // Idempotent for the same live grant.
    const again = await grant(t.admin, body);
    expect(again.status).toBe(200);
    expect((await json(again)).id).toBe((await json(ok)).id);
    expect((await json(await api("/api/v1/org/viewers", { headers: t.admin.headers }))).length).toBe(1);
  });

  it("validates the target: non-member, wrong scope shape, non-leader, cross-org", async () => {
    const t = await seedTeam();
    const other = await seedTeam();
    const outsider = await member(other.org, "member");
    expect((await grant(t.admin, { user_id: outsider.userId, scope: "org" })).status).toBe(400);
    expect((await grant(t.admin, { user_id: t.rep1.userId, scope: "team" })).status).toBe(400); // no leader
    expect((await grant(t.admin, { user_id: t.rep1.userId, scope: "org", leader_user_id: t.leader.userId })).status).toBe(400);
    expect((await grant(t.admin, { user_id: t.rep1.userId, scope: "team", leader_user_id: t.rep2.userId })).status).toBe(400); // rep2 leads nobody
    expect((await grant(t.admin, { user_id: t.rep1.userId, scope: "team", leader_user_id: other.leader.userId })).status).toBe(400); // other org's leader
  });

  it("revoking removes access at once; another org's admin cannot revoke it", async () => {
    const t = await seedTeam();
    const other = await seedTeam();
    const viewer = await member(t.org, "viewer");
    const g = await json(await grant(t.admin, { user_id: viewer.userId, scope: "org" }));
    expect((await summary(viewer)).status).toBe(200);
    expect((await api(`/api/v1/org/viewers/${g.id}`, { method: "DELETE", headers: other.admin.headers })).status).toBe(404);
    expect((await summary(viewer)).status).toBe(200);
    expect((await api(`/api/v1/org/viewers/${g.id}`, { method: "DELETE", headers: t.admin.headers })).status).toBe(204);
    expect((await summary(viewer)).status).toBe(403);
    expect((await api(`/api/v1/org/viewers/${g.id}`, { method: "DELETE", headers: t.admin.headers })).status).toBe(204); // idempotent
  });
});

describe("a viewer reads reports and nothing else", () => {
  it("viewer role without a grant sees no reporting", async () => {
    const t = await seedTeam();
    const viewer = await member(t.org, "viewer");
    expect((await summary(viewer)).status).toBe(403);
  });

  it("org grant: full-org read, every write and admin route refused", async () => {
    const t = await seedTeam();
    await seedActivity(t);
    const viewer = await member(t.org, "viewer");
    await grant(t.admin, { user_id: viewer.userId, scope: "org" });

    const res = await json(await summary(viewer));
    expect(res.scope).toBe("org");
    expect(res.totals).toEqual({ shares_created: 4, opens: 8, clicks: 2 });

    const dom = await seedDomain(t.admin.userId, "viewer-test.acme.test");
    const denied: [string, string, object?][] = [
      ["POST", "/api/v1/org/viewers", { user_id: viewer.userId, scope: "org" }],
      ["PATCH", `/api/v1/org/members/${t.rep1.userId}`, { leader_user_id: null }],
      ["POST", "/api/v1/org/assignments", { champvault_asset_id: "a", assigned_to_user_id: t.rep1.userId }],
      ["POST", `/api/v1/org/domains/${dom}/default`, {}],
      ["POST", `/api/v1/org/domains/${dom}/attach`, {}],
      ["GET", "/api/v1/org/members"],
      ["GET", "/api/v1/org/analytics/content"],
      ["GET", "/api/v1/org/viewers"],
    ];
    for (const [method, path, body] of denied) {
      const r = await api(path, { method, headers: viewer.headers, ...(body ? { json: body } : {}) });
      expect(r.status, `${method} ${path}`).toBe(403);
    }
    // The grant did not touch membership: still role viewer, no admin flag.
    const ctx = await json(await api("/api/v1/org/context", { headers: viewer.headers }));
    expect(ctx).toMatchObject({ role: "viewer", is_admin: false });
    const prof = await json(await api("/api/v1/org/profile", { headers: viewer.headers }));
    expect(prof.permissions).toEqual([]);
    expect(prof.report_scope).toBe("org");
  });

  it("team grant: that leader's team only; out-of-scope filters are refused", async () => {
    const t = await seedTeam();
    await seedActivity(t);
    const viewer = await member(t.org, "viewer");
    await grant(t.admin, { user_id: viewer.userId, scope: "team", leader_user_id: t.leader.userId });

    const res = await json(await summary(viewer));
    expect(res.scope).toBe("team");
    // rep1 only (rep2 is unassigned): 2 shares + 1 link, 4 opens, 2 clicks.
    expect(res.totals).toEqual({ shares_created: 3, opens: 4, clicks: 2 });
    expect(res.by_member.map((m: any) => m.user_id)).toEqual([t.rep1.userId]);

    expect((await summary(viewer, `?user=${t.rep2.userId}`)).status).toBe(403);
    expect((await summary(viewer, `?team=${t.admin.userId}`)).status).toBe(403);
    expect((await summary(viewer, `?user=${t.rep1.userId}`)).status).toBe(200);
  });

  it("an API key gets no reporting (no org context, no inherited admin)", async () => {
    const t = await seedTeam();
    const key = apiKeyHeaders(await createApiKey(t.admin.userId));
    expect((await api("/api/v1/org/reporting/summary", { headers: key })).status).toBe(403);
    expect((await api("/api/v1/org/viewers", { headers: key })).status).toBe(403);
  });
});

describe("stale sessions, revocation and org switching", () => {
  it("revoked membership: a live token and its grant both stop working", async () => {
    const t = await seedTeam();
    const viewer = await member(t.org, "viewer");
    await grant(t.admin, { user_id: viewer.userId, scope: "org" });
    expect((await summary(viewer)).status).toBe(200);
    await env.DB.prepare("UPDATE organization_memberships SET status='revoked' WHERE user_id = ?").bind(viewer.userId).run();
    expect([401, 403]).toContain((await summary(viewer)).status);
    // Granting to a revoked member is refused as well.
    expect((await grant(t.admin, { user_id: viewer.userId, scope: "org" })).status).toBe(400);
  });

  it("a grant in org A gives nothing in org B for the same person", async () => {
    const a = await seedTeam();
    const b = await seedTeam();
    await seedActivity(a);
    const viewer = await member(a.org, "viewer");
    await grant(a.admin, { user_id: viewer.userId, scope: "org" });
    const sub = viewer.sub;
    // Same Clerk user, token switched to org B where they are a plain viewer.
    const tokB = await clerkToken({ sub, org: { id: b.org, rol: "org:viewer", slg: "b" } });
    const inB = { headers: bearer(tokB) };
    expect((await summary(inB)).status).toBe(403);
    expect((await json(await summary(viewer))).totals.shares_created).toBe(4);
  });

  it("an org admin elsewhere cannot read this org by sending its id", async () => {
    const a = await seedTeam();
    const b = await seedTeam();
    await seedActivity(a);
    const res = await json(await summary(b.admin, `?team=${a.leader.userId}`));
    expect(res.totals).toEqual({ shares_created: 0, opens: 0, clicks: 0 }); // a's team has no members in b
  });
});

describe("reporting numbers and filters", () => {
  it("splits files, pages and links; filters by kind, user and time; never claims email sent", async () => {
    const t = await seedTeam();
    await seedActivity(t);
    const all = await json(await summary(t.admin));
    expect(all.by_kind).toEqual({
      file: { shares_created: 1, opens: 1, clicks: 0 },
      page: { shares_created: 2, opens: 7, clicks: 0 },
      link: { shares_created: 1, opens: 0, clicks: 2 },
    });
    expect(all.emails_sent).toMatchObject({ status: "not_measured", count: null });

    const pagesOnly = await json(await summary(t.admin, "?kind=page"));
    expect(pagesOnly.totals).toEqual({ shares_created: 2, opens: 7, clicks: 0 });
    const rep2 = await json(await summary(t.admin, `?user=${t.rep2.userId}`));
    expect(rep2.totals).toEqual({ shares_created: 1, opens: 4, clicks: 0 });
    const team = await json(await summary(t.admin, `?team=${t.leader.userId}`));
    expect(team.totals).toEqual({ shares_created: 3, opens: 4, clicks: 2 });

    const future = new Date(Date.now() + 3_600_000).toISOString();
    const none = await json(await summary(t.admin, `?from=${encodeURIComponent(future)}`));
    expect(none.totals).toEqual({ shares_created: 0, opens: 0, clicks: 0 });
    expect((await summary(t.admin, "?from=not-a-date")).status).toBe(400);
    expect((await summary(t.admin, "?kind=email")).status).toBe(422);
    expect((await summary(t.admin, "?user=nope")).status).toBe(400);
  });

  it("a member sees only their own; a leader their team; personal items stay out", async () => {
    const t = await seedTeam();
    await seedActivity(t);
    await seedFile(t.rep1.userId, { organization_id: null }); // personal asset, not org reporting
    expect((await json(await summary(t.rep2))).totals).toEqual({ shares_created: 1, opens: 4, clicks: 0 });
    expect((await json(await summary(t.leader))).totals).toEqual({ shares_created: 3, opens: 4, clicks: 2 });
    expect((await summary(t.rep2, `?user=${t.rep1.userId}`)).status).toBe(403);
  });
});

describe("profile context", () => {
  it("returns org, role, permissions, scope and share host; API key has no org", async () => {
    const t = await seedTeam();
    const p = await json(await api("/api/v1/org/profile", { headers: t.admin.headers }));
    expect(p).toMatchObject({ role: "admin", report_scope: "org", org: { id: t.org } });
    expect(p.permissions).toContain("org.viewers.grant");
    expect(p.share_host.default).toBeTruthy();
    const m = await json(await api("/api/v1/org/profile", { headers: t.rep1.headers }));
    expect(m.permissions).not.toContain("org.viewers.grant");
    expect(m.report_scope).toBe("own");

    const u = await createUser();
    const k = await json(await api("/api/v1/org/profile", { headers: apiKeyHeaders(await createApiKey(u.id)) }));
    expect(k).toMatchObject({ org: null, role: null, permissions: [], report_scope: "none" });
  });
});

describe("org domains", () => {
  const orgDom = async (orgId: string, creator: string, hostname: string, status = "active") => {
    const id = await seedDomain(creator, hostname, status);
    await env.DB.prepare("UPDATE domains SET organization_id = ? WHERE id = ?").bind(orgId, id).run();
    return id;
  };

  it("admin attaches own verified domain and sets the default; one default per org", async () => {
    const t = await seedTeam();
    const mine = await seedDomain(t.admin.userId, `a-${crypto.randomUUID().slice(0, 6)}.acme.test`);
    const pending = await seedDomain(t.admin.userId, `p-${crypto.randomUUID().slice(0, 6)}.acme.test`, "pending_cname");
    expect((await api(`/api/v1/org/domains/${mine}/attach`, { method: "POST", headers: t.rep1.headers })).status).toBe(403);
    expect((await api(`/api/v1/org/domains/${pending}/attach`, { method: "POST", headers: t.admin.headers })).status).toBe(400);
    expect((await api(`/api/v1/org/domains/${mine}/attach`, { method: "POST", headers: t.admin.headers })).status).toBe(200);

    const o = await orgUuid(t.org);
    const second = await orgDom(o, t.admin.userId, `b-${crypto.randomUUID().slice(0, 6)}.acme.test`);
    expect((await api(`/api/v1/org/domains/${mine}/default`, { method: "POST", headers: t.admin.headers })).status).toBe(200);
    expect((await api(`/api/v1/org/domains/${second}/default`, { method: "POST", headers: t.admin.headers })).status).toBe(200);
    const n = await row<{ n: number }>("SELECT COUNT(*) AS n FROM domains WHERE organization_id = ? AND is_org_default = 1", o);
    expect(n!.n).toBe(1);
    expect((await row<{ is_org_default: number }>("SELECT is_org_default FROM domains WHERE id = ?", second))!.is_org_default).toBe(1);
    // New org shares default to it.
    const prof = await json(await api("/api/v1/org/profile", { headers: t.rep1.headers }));
    expect(prof.share_host.default_domain_id).toBe(second);
  });

  it("members list only active org hosts; another org's domain is untouchable", async () => {
    const t = await seedTeam();
    const other = await seedTeam();
    const o = await orgUuid(t.org);
    const active = await orgDom(o, t.admin.userId, `x-${crypto.randomUUID().slice(0, 6)}.acme.test`);
    await orgDom(o, t.admin.userId, `y-${crypto.randomUUID().slice(0, 6)}.acme.test`, "pending_cname");
    expect((await json(await api("/api/v1/org/domains", { headers: t.rep1.headers }))).map((d: any) => d.id)).toEqual([active]);
    expect((await json(await api("/api/v1/org/domains", { headers: t.admin.headers }))).length).toBe(2);
    expect((await api(`/api/v1/org/domains/${active}/default`, { method: "POST", headers: other.admin.headers })).status).toBe(404);
    const theirs = await seedDomain(other.admin.userId, `z-${crypto.randomUUID().slice(0, 6)}.acme.test`);
    expect((await api(`/api/v1/org/domains/${theirs}/attach`, { method: "POST", headers: t.admin.headers })).status).toBe(404);
  });
});
