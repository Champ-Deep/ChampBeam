import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs ops script, no type declarations
import { run } from "../scripts/clerk_bulk_membership.mjs";

const OLD = Date.parse("2026-01-01T00:00:00Z");
const NEW = Date.parse("2026-11-01T00:00:00Z");

// Fake Clerk: u1 and u2 are old, u3 is created after the cutoff; u2 is already a member.
function fakeClerk() {
  const posts: { path: string; body: { user_id: string; role: string } }[] = [];
  const patches: { path: string; body: unknown }[] = [];
  const f = async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname;
    if (init.method === "PATCH") {
      patches.push({ path, body: JSON.parse(String(init.body)) });
      return Response.json({ id: path.split("/").pop() });
    }
    if (init.method === "POST") {
      posts.push({ path, body: JSON.parse(String(init.body)) });
      return Response.json({ id: "orgmem_x" });
    }
    if (path === "/v1/users") {
      return Response.json([
        { id: "u1", created_at: OLD },
        { id: "u2", created_at: OLD, create_organization_enabled: false },
        { id: "u3", created_at: NEW },
      ]);
    }
    return Response.json({ data: [{ public_user_data: { user_id: "u2" } }], total_count: 1 });
  };
  return { f, posts, patches };
}

const env = { CLERK_SECRET_KEY: "sk_test_x", ORG_ID: "org_1", BEFORE: "2026-10-26T00:00:00Z" };

describe("clerk_bulk_membership", () => {
  it("adds old non-members as org:member, skips existing members and users after BEFORE", async () => {
    const { f, posts, patches } = fakeClerk();
    const counts = await run({ env, apply: true, fetch: f, log: () => {} });
    expect(counts).toEqual({ eligible: 2, already_member: 1, excluded: 0, added: 1, would_add: 0, failed: 0, creation_locked: 1, would_lock: 0 });
    expect(posts).toEqual([{ path: "/v1/organizations/org_1/memberships", body: { user_id: "u1", role: "org:member" } }]);
    // u2 is already locked and u3 joined after the cutoff: only u1 loses org creation.
    expect(patches).toEqual([{ path: "/v1/users/u1", body: { create_organization_enabled: false } }]);
  });

  it("treats a 409 on POST as already a member", async () => {
    const { f } = fakeClerk();
    const g = async (url: string, init: RequestInit = {}) => (init.method === "POST" ? new Response("{}", { status: 409 }) : f(url, init));
    const counts = await run({ env, apply: true, fetch: g, log: () => {} });
    expect(counts).toMatchObject({ already_member: 2, added: 0, failed: 0 });
  });

  it("never re-adds a user listed in EXCLUDE (an admin removed them; D1 holds the tombstone)", async () => {
    const { f, posts } = fakeClerk();
    const counts = await run({ env: { ...env, EXCLUDE: " u9, u1 " }, apply: true, fetch: f, log: () => {} });
    expect(counts).toMatchObject({ excluded: 1, added: 0, failed: 0 });
    expect(posts).toEqual([]);
  });

  it("dry run writes nothing", async () => {
    const { f, posts, patches } = fakeClerk();
    const counts = await run({ env, apply: false, fetch: f, log: () => {} });
    expect(counts).toMatchObject({ would_add: 1, added: 0, would_lock: 1, creation_locked: 0 });
    expect(posts).toEqual([]);
    expect(patches).toEqual([]);
  });
});
