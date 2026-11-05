/** /api/v1/projects (no Python test file exists; covers the router contract). */
import { describe, expect, it } from "vitest";
import { api, authedUser, env } from "./helpers";
import { code, seedLink } from "./serveSeed";

describe("projects router", () => {
  it("requires auth", async () => {
    expect((await api("/api/v1/projects")).status).toBe(401);
    expect((await api("/api/v1/projects", { method: "POST", json: { name: "x" } })).status).toBe(401);
  });

  it("create, list with stats, update, delete", async () => {
    const { user, headers } = await authedUser();
    const created = await api("/api/v1/projects", { method: "POST", headers, json: { name: "Q4", description: "launch" } });
    expect(created.status).toBe(201);
    const p = await created.json<any>();
    expect(p).toMatchObject({ name: "Q4", description: "launch", link_count: 0, total_clicks: 0 });
    expect(p.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+$/); // naive isoformat, no "Z"

    await seedLink(user.id, code("p"), { project_id: p.id, click_count: 3 });
    await seedLink(user.id, code("p"), { project_id: p.id, click_count: 4 });

    const listed = await (await api("/api/v1/projects", { headers })).json<any[]>();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: p.id, link_count: 2, total_clicks: 7 });

    const upd = await api(`/api/v1/projects/${p.id}`, { method: "PUT", headers, json: { name: "Q4 v2" } });
    expect(upd.status).toBe(200);
    expect(await upd.json()).toMatchObject({ name: "Q4 v2", description: "launch", link_count: 2, total_clicks: 7 });

    // Another user can't see or touch it.
    const other = await authedUser();
    expect(await (await api("/api/v1/projects", { headers: other.headers })).json()).toEqual([]);
    const nf = await api(`/api/v1/projects/${p.id}`, { method: "PUT", headers: other.headers, json: { name: "x" } });
    expect(nf.status).toBe(404);
    expect(await nf.json()).toEqual({ detail: "Project not found" });
    expect((await api(`/api/v1/projects/${p.id}`, { method: "DELETE", headers: other.headers })).status).toBe(404);

    const del = await api(`/api/v1/projects/${p.id}`, { method: "DELETE", headers });
    expect(del.status).toBe(204);
    // Links survive, detached.
    const links = await env.DB.prepare("SELECT project_id FROM link_clicks WHERE user_id = ?").bind(user.id).all();
    expect(links.results.map((l: any) => l.project_id)).toEqual([null, null]);
    expect(await (await api("/api/v1/projects", { headers })).json()).toEqual([]);
  });

  it("validates the body", async () => {
    const { headers } = await authedUser();
    expect((await api("/api/v1/projects", { method: "POST", headers, json: {} })).status).toBe(422);
    expect((await api("/api/v1/projects", { method: "POST", headers, json: { name: 5 } })).status).toBe(422);
  });
});
