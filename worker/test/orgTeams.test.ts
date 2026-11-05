/**
 * Port of backend/tests/test_org_teams.py — the team hierarchy: role tiers +
 * leader-scoped analytics. A super admin sees the whole org; a leader sees only
 * the reps assigned to them (+ their own activity); a plain member sees no team
 * analytics. Super admins assign reps to leaders via PATCH /org/members/{id}.
 */
import { describe, expect, it } from "vitest";
import { api, json } from "./helpers";
import { useRouteTestHooks, addClicks, seedTeam, shareLinkId } from "./orgTestUtils";

useRouteTestHooks();

type Team = Awaited<ReturnType<typeof seedTeam>>;

/** Admin creates content; rep1 and rep2 each share; clicks land on each. */
async function setupContentWithShares(t: Team): Promise<string> {
  const res = await api("/api/v1/content", {
    method: "POST",
    headers: t.admin.headers,
    json: { title: "Deck", kind: "link", canonical_url: "https://e.com/deck" },
  });
  expect(res.status).toBe(201);
  const contentId = (await json(res)).id as string;

  for (const rep of [t.rep1, t.rep2]) {
    const r = await api(`/api/v1/content/${contentId}/share`, { method: "POST", headers: rep.headers, json: {} });
    expect(r.status).toBe(201);
  }
  await addClicks(await shareLinkId(contentId, t.rep1.userId), ["1.1.1.1", "1.1.1.2"]);
  await addClicks(await shareLinkId(contentId, t.rep2.userId), ["2.2.2.1", "2.2.2.2", "2.2.2.3"]);
  return contentId;
}

const contentReport = async (headers: Record<string, string>) =>
  json(await api("/api/v1/org/analytics/content", { headers }));

describe("org team hierarchy", () => {
  it("super admin sees all; leader sees only their reps", async () => {
    const t = await seedTeam();
    const contentId = await setupContentWithShares(t);

    // Super admin: both reps roll up (2 sharers, 5 opens).
    const adminItem = (await contentReport(t.admin.headers)).items[0];
    expect(adminItem.shares).toBe(2);
    expect(adminItem.opens).toBe(5);

    // Leader: only rep1 (their rep) counts — 1 share, 2 opens. rep2 is excluded.
    const report = await contentReport(t.leader.headers);
    const leaderItem = report.items.find((i: any) => i.content_id === contentId);
    expect(leaderItem.shares).toBe(1);
    expect(leaderItem.opens).toBe(2);

    // Leader roster is scoped to themselves + their reps (no rep2).
    const roster = await json(await api("/api/v1/org/members", { headers: t.leader.headers }));
    expect(new Set(roster.map((m: any) => m.full_name))).toEqual(new Set(["Leah Leader", "Rep One"]));

    // Breakdown for the leader shows only rep1.
    const bd = await json(await api(`/api/v1/org/analytics/content/${contentId}`, { headers: t.leader.headers }));
    expect(bd.members.map((m: any) => m.full_name)).toEqual(["Rep One"]);
    expect(bd.opens).toBe(2);
  });

  it("plain member cannot see team analytics", async () => {
    const t = await seedTeam();
    expect((await api("/api/v1/org/members", { headers: t.rep2.headers })).status).toBe(403);
    expect((await api("/api/v1/org/analytics/content", { headers: t.rep2.headers })).status).toBe(403);
  });

  it("admin assigns rep to leader and scope updates", async () => {
    const t = await seedTeam();
    const contentId = await setupContentWithShares(t);

    const before = (await contentReport(t.leader.headers)).items.find((i: any) => i.content_id === contentId);
    expect(before.shares).toBe(1);

    // A member cannot assign leaders.
    const denied = await api(`/api/v1/org/members/${t.rep2.userId}`, {
      method: "PATCH",
      headers: t.rep1.headers,
      json: { leader_user_id: t.leader.userId },
    });
    expect(denied.status).toBe(403);

    // Super admin assigns rep2 to the leader.
    const r = await api(`/api/v1/org/members/${t.rep2.userId}`, {
      method: "PATCH",
      headers: t.admin.headers,
      json: { leader_user_id: t.leader.userId },
    });
    expect(r.status).toBe(200);
    expect((await json(r)).leader_user_id).toBe(t.leader.userId);

    // Now the leader sees both reps (2 shares, 5 opens).
    const after = (await contentReport(t.leader.headers)).items.find((i: any) => i.content_id === contentId);
    expect(after.shares).toBe(2);
    expect(after.opens).toBe(5);
  });

  it("validates leader assignment", async () => {
    const t = await seedTeam();
    const patch = (leader: string | null) =>
      api(`/api/v1/org/members/${t.rep1.userId}`, {
        method: "PATCH",
        headers: t.admin.headers,
        json: { leader_user_id: leader },
      });

    // Self-lead rejected.
    const self = await patch(t.rep1.userId);
    expect(self.status).toBe(400);
    expect((await json(self)).detail).toBe("A member cannot lead themselves.");
    // Target that isn't a leader/admin rejected.
    const notLeader = await patch(t.rep2.userId);
    expect(notLeader.status).toBe(400);
    expect((await json(notLeader)).detail).toBe("That member is not a leader or admin.");
    // Garbage ids.
    expect((await patch("nope")).status).toBe(400);
    expect(
      (await api("/api/v1/org/members/not-a-uuid", { method: "PATCH", headers: t.admin.headers, json: {} })).status,
    ).toBe(400);
    // Clearing the assignment works.
    const ok = await patch(null);
    expect(ok.status).toBe(200);
    const okBody = await json(ok);
    expect(okBody.leader_user_id).toBeNull();
    expect(okBody.role).toBe("member");
  });
});
