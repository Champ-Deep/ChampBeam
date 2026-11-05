/**
 * Port of backend/tests/test_org_content.py — the org content library +
 * consolidated analytics: an admin curates content, members share it via their
 * own links, clicks land on each member's link, and the admin's consolidated
 * report rolls everything up under one content item. Plus coverage of the rest
 * of /content (update/archive/delete, mine/shares, gating).
 */
import { describe, expect, it } from "vitest";
import { api, authedUser, env, json } from "./helpers";
import { useRouteTestHooks, addClicks, member, newOrgId, shareLinkId } from "./orgTestUtils";

useRouteTestHooks();

/** An org with an admin + one member (_seed_org). */
async function seedOrg() {
  const org = newOrgId();
  const admin = await member(org, "admin", "Ada Admin");
  const mark = await member(org, "member", "Mark Member");
  return { org, admin, mark };
}

async function createLink(headers: Record<string, string>, title = "Q3 Pitch", url = "https://example.com/pitch") {
  return api("/api/v1/content", { method: "POST", headers, json: { title, kind: "link", canonical_url: url } });
}

const share = (headers: Record<string, string>, id: string, body: unknown = {}) =>
  api(`/api/v1/content/${id}/share`, { method: "POST", headers, json: body });

describe("org content library", () => {
  it("content share and consolidated analytics", async () => {
    const { admin, mark } = await seedOrg();
    const resp = await createLink(admin.headers);
    expect(resp.status).toBe(201);
    const created = await json(resp);
    expect(created).toMatchObject({ kind: "link", share_count: 0, my_share: null, is_archived: false, file_id: null });
    expect(created.created_at).toMatch(/Z$/);
    const contentId = created.id;

    // Admin shares it, then the member shares it — two distinct links.
    expect((await share(admin.headers, contentId)).status).toBe(201);
    expect((await share(mark.headers, contentId)).status).toBe(201);
    const adminLink = await shareLinkId(contentId, admin.userId);
    const memberLink = await shareLinkId(contentId, mark.userId);
    expect(adminLink).not.toBe(memberLink);

    // Clicks: admin link 3 opens / 2 unique; member link 5 opens / 5 unique.
    await addClicks(adminLink, ["1.1.1.1", "1.1.1.1", "2.2.2.2"]);
    await addClicks(memberLink, ["3.3.3.3", "4.4.4.4", "5.5.5.5", "6.6.6.6", "7.7.7.7"]);

    // Member cannot see the admin analytics.
    expect((await api("/api/v1/org/analytics/content", { headers: mark.headers })).status).toBe(403);

    // Admin consolidated report: one content item, 8 opens, 7 unique, 2 sharers.
    const report = await json(await api("/api/v1/org/analytics/content", { headers: admin.headers }));
    expect(report.total_content).toBe(1);
    expect(report.total_shares).toBe(2);
    expect(report.total_opens).toBe(8);
    const item = report.items[0];
    expect(item.content_id).toBe(contentId);
    expect(item.opens).toBe(8);
    expect(item.unique_opens).toBe(7);
    expect(item.shares).toBe(2);
    expect(item.sharing_members).toBe(2);
    expect(item.last_engaged_at).toMatch(/Z$/);

    // Per-member breakdown: member (5) ranks above admin (3).
    const breakdown = await json(await api(`/api/v1/org/analytics/content/${contentId}`, { headers: admin.headers }));
    expect(breakdown.opens).toBe(8);
    expect(breakdown.members[0].opens).toBe(5);
    expect(breakdown.members[0].full_name).toBe("Mark Member");
    expect(breakdown.members[1].opens).toBe(3);

    // Member roster reflects sharing activity.
    const roster = await json(await api("/api/v1/org/members", { headers: admin.headers }));
    const byName = Object.fromEntries(roster.map((m: any) => [m.full_name, m]));
    expect(byName["Mark Member"].opens).toBe(5);
    expect(byName["Ada Admin"].shares).toBe(1);
    expect(roster[0].full_name).toBe("Mark Member"); // sorted by opens

    // Library listing annotates the caller's own share with its open count.
    const lib = await json(await api("/api/v1/content", { headers: mark.headers }));
    expect(lib[0].share_count).toBe(2);
    expect(lib[0].my_share.opens).toBe(5);
    expect(lib[0].my_share.share_url).toMatch(/^https:\/\/share\.example\.com\/r\/\w+$/);

    // mine/shares lists the caller's shares only.
    const mine = await json(await api("/api/v1/content/mine/shares", { headers: mark.headers }));
    expect(mine).toHaveLength(1);
    expect(mine[0].id).toBe(contentId);
    expect(mine[0].share_count).toBe(0);
    expect(mine[0].my_share.opens).toBe(5);
  });

  it("resharing is idempotent", async () => {
    const { admin, mark } = await seedOrg();
    const contentId = (await json(await createLink(admin.headers, "Deck", "https://example.com/deck"))).id;
    const first = await share(mark.headers, contentId);
    const second = await share(mark.headers, contentId);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect((await json(first)).share_url).toBe((await json(second)).share_url);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM content_shares WHERE content_id = ? AND shared_by_user_id = ?")
      .bind(contentId, mark.userId)
      .first<{ n: number }>();
    expect(n?.n).toBe(1);
  });

  it("org context and member gating", async () => {
    const { org, mark } = await seedOrg();
    const ctx = await api("/api/v1/org/context", { headers: mark.headers });
    expect(ctx.status).toBe(200);
    const body = await json(ctx);
    expect(body.org_id).toBe(org);
    expect(body.is_admin).toBe(false);
    expect(body.role).toBe("member");
    expect(body.member_count).toBe(2);

    // A member can browse the library but not create content.
    expect((await api("/api/v1/content", { headers: mark.headers })).status).toBe(200);
    expect((await createLink(mark.headers, "x", "https://e.com")).status).toBe(403);
  });

  it("requires an org for team endpoints", async () => {
    const { headers } = await authedUser();
    const res = await api("/api/v1/content", { headers });
    expect(res.status).toBe(403);
    expect((await json(res)).detail).toBe("Select an organization to use team features.");
    expect((await api("/api/v1/org/context")).status).toBe(401);
  });

  it("validates create, then updates, archives and deletes", async () => {
    const { admin, mark } = await seedOrg();
    const bad = await api("/api/v1/content", {
      method: "POST",
      headers: admin.headers,
      json: { title: "x", kind: "link" },
    });
    expect(bad.status).toBe(400);
    expect((await json(bad)).detail).toBe("Link content needs a canonical_url.");
    const badKind = await api("/api/v1/content", {
      method: "POST",
      headers: admin.headers,
      json: { title: "x", kind: "video" },
    });
    expect(badKind.status).toBe(422);
    const noFile = await api("/api/v1/content", {
      method: "POST",
      headers: admin.headers,
      json: { title: "x", kind: "file", file_id: crypto.randomUUID() },
    });
    expect(noFile.status).toBe(400);
    expect((await json(noFile)).detail).toBe("File not found, not yours, or not active.");

    const id = (await json(await createLink(admin.headers))).id;
    const patched = await api(`/api/v1/content/${id}`, {
      method: "PATCH",
      headers: admin.headers,
      json: { title: "Renamed", is_archived: true },
    });
    expect(patched.status).toBe(200);
    expect(await json(patched)).toMatchObject({ title: "Renamed", is_archived: true });

    // Archived content is hidden from the library and can't be shared.
    expect(await json(await api("/api/v1/content", { headers: mark.headers }))).toEqual([]);
    const archived = await share(mark.headers, id);
    expect(archived.status).toBe(409);
    expect((await json(archived)).detail).toBe("This content is archived.");

    // Members can't edit; bad/unknown ids.
    expect((await api(`/api/v1/content/${id}`, { method: "PATCH", headers: mark.headers, json: {} })).status).toBe(403);
    expect((await api(`/api/v1/content/nope`, { method: "PATCH", headers: admin.headers, json: {} })).status).toBe(400);
    expect(
      (await api(`/api/v1/content/${crypto.randomUUID()}`, { method: "DELETE", headers: admin.headers })).status,
    ).toBe(404);

    expect((await api(`/api/v1/content/${id}`, { method: "DELETE", headers: admin.headers })).status).toBe(204);
    expect((await api(`/api/v1/content/${id}`, { method: "DELETE", headers: admin.headers })).status).toBe(404);
  });

  it("share accepts an empty or non-JSON body", async () => {
    const { admin, mark } = await seedOrg();
    const id = (await json(await createLink(admin.headers))).id;
    const r1 = await api(`/api/v1/content/${id}/share`, { method: "POST", headers: mark.headers });
    expect(r1.status).toBe(201);
    const r2 = await api(`/api/v1/content/${id}/share`, {
      method: "POST",
      headers: { ...mark.headers, "Content-Type": "application/x-www-form-urlencoded" },
      body: "{}garbage",
    });
    expect(r2.status).toBe(201);
    expect((await json(r2)).share_url).toBe((await json(r1)).share_url);
    // A bad domain_id is a 400 from the service.
    const r3 = await share(mark.headers, id, { domain_id: "nope" });
    expect(r3.status).toBe(400);
    expect((await json(r3)).detail).toBe("Invalid domain_id.");
  });
});
