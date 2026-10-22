/**
 * Port of backend/tests/test_org_assignments.py — soft assignments: leader ->
 * rep recommendations. Soft = never gates sending. Once the rep actually sends
 * the asset, the assignment's `sent` flips true (derived from the ContentShare).
 */
import { describe, expect, it } from "vitest";
import { api, json } from "./helpers";
import { mockVault, seedTeam, useRouteTestHooks } from "./orgTestUtils";

useRouteTestHooks();

const assign = (headers: Record<string, string>, body: Record<string, unknown>) =>
  api("/api/v1/org/assignments", { method: "POST", headers, json: body });

describe("org assignments", () => {
  it("leader assigns and scope is enforced", async () => {
    const t = await seedTeam();

    // Leader assigns to their rep -> ok, not yet sent.
    const r = await assign(t.leader.headers, {
      champvault_asset_id: "deck_a",
      asset_title: "Pitch A",
      assigned_to_user_id: t.rep1.userId,
      note: "Use this for enterprise leads",
    });
    expect(r.status).toBe(201);
    const body = await json(r);
    expect(body.sent).toBe(false);
    expect(body.asset_title).toBe("Pitch A");
    expect(body.assigned_by_user_id).toBe(t.leader.userId);
    expect(body.created_at).toMatch(/Z$/);

    // Leader cannot assign to a rep that isn't theirs.
    const bad = await assign(t.leader.headers, { champvault_asset_id: "deck_a", assigned_to_user_id: t.rep2.userId });
    expect(bad.status).toBe(403);
    expect((await json(bad)).detail).toBe("You can only assign to your own reps.");

    // Super admin can assign to anyone.
    expect(
      (await assign(t.admin.headers, { champvault_asset_id: "deck_a", assigned_to_user_id: t.rep2.userId })).status,
    ).toBe(201);

    // Rep sees their assignment on their shelf.
    const mine = await json(await api("/api/v1/org/assignments/mine", { headers: t.rep1.headers }));
    expect(mine).toHaveLength(1);
    expect(mine[0].champvault_asset_id).toBe("deck_a");
    expect(mine[0].sent).toBe(false);

    // Admin sees every assignment in the org; the leader only their own.
    expect(await json(await api("/api/v1/org/assignments", { headers: t.admin.headers }))).toHaveLength(2);
    expect(await json(await api("/api/v1/org/assignments", { headers: t.leader.headers }))).toHaveLength(1);
  });

  it("sent flips true after rep sends", async () => {
    const t = await seedTeam();
    mockVault();

    await assign(t.leader.headers, { champvault_asset_id: "deck_b", assigned_to_user_id: t.rep1.userId });

    // Rep sends the asset from the library -> assignment now reads as sent.
    const beam = await api("/api/v1/champvault/assets/deck_b/beam", { method: "POST", headers: t.rep1.headers, json: {} });
    expect(beam.status).toBe(201);
    const mine = await json(await api("/api/v1/org/assignments/mine", { headers: t.rep1.headers }));
    expect(mine[0].sent).toBe(true);

    // Leader's own list reflects the sent status too.
    const made = await json(await api("/api/v1/org/assignments", { headers: t.leader.headers }));
    expect(made[0].sent).toBe(true);
  });

  it("assignment is idempotent, updates and deletes", async () => {
    const t = await seedTeam();
    const first = await json(
      await assign(t.leader.headers, { champvault_asset_id: "deck_c", assigned_to_user_id: t.rep1.userId, note: "v1" }),
    );
    const second = await json(
      await assign(t.leader.headers, { champvault_asset_id: "deck_c", assigned_to_user_id: t.rep1.userId, note: "v2" }),
    );
    expect(first.id).toBe(second.id); // same row, updated
    expect(second.note).toBe("v2");

    // Rep has exactly one assignment for the asset.
    expect(await json(await api("/api/v1/org/assignments/mine", { headers: t.rep1.headers }))).toHaveLength(1);

    // Another leader-tier user can't withdraw it; unknown / bad ids.
    expect(
      (await api(`/api/v1/org/assignments/${crypto.randomUUID()}`, { method: "DELETE", headers: t.leader.headers }))
        .status,
    ).toBe(404);
    expect((await api(`/api/v1/org/assignments/nope`, { method: "DELETE", headers: t.leader.headers })).status).toBe(
      400,
    );

    // Leader withdraws it.
    expect((await api(`/api/v1/org/assignments/${first.id}`, { method: "DELETE", headers: t.leader.headers })).status).toBe(
      204,
    );
    expect(await json(await api("/api/v1/org/assignments/mine", { headers: t.rep1.headers }))).toEqual([]);
  });

  it("plain member cannot assign", async () => {
    const t = await seedTeam();
    expect(
      (await assign(t.rep2.headers, { champvault_asset_id: "deck_a", assigned_to_user_id: t.rep1.userId })).status,
    ).toBe(403);
    expect((await api("/api/v1/org/assignments", { headers: t.rep2.headers })).status).toBe(403);
  });

  it("rejects assignees outside the org", async () => {
    const t = await seedTeam();
    const r = await assign(t.admin.headers, { champvault_asset_id: "x", assigned_to_user_id: crypto.randomUUID() });
    expect(r.status).toBe(400);
    expect((await json(r)).detail).toBe("Assignee is not a member of this org.");
    const bad = await assign(t.admin.headers, { champvault_asset_id: "x", assigned_to_user_id: "nope" });
    expect((await json(bad)).detail).toBe("Invalid assigned_to_user_id.");
  });
});
