/** A viewer seat (permissions []) is an org member with NO share or report rights: rooms, content share and beam refuse it. */
import { expect, it } from "vitest";
import { api, env, json } from "./helpers";
import { member, mockVault, newOrgId, useRouteTestHooks } from "./orgTestUtils";

useRouteTestHooks();
const post = (p: string, h: Record<string, string>, body?: unknown) => api(p, { method: "POST", headers: h, ...(body === undefined ? {} : { json: body }) });

it("viewer cannot create/publish/archive rooms, mint recipients, read lead analytics, share content or beam", async () => {
  const org = newOrgId();
  const admin = await member(org, "admin");
  const owner = await member(org, "member");
  const viewer = await member(org, "viewer");

  expect((await post("/api/v1/rooms", viewer.headers, { title: "V Room" })).status).toBe(403);
  const room = await json(await post("/api/v1/rooms", owner.headers, { title: "Owner Room" }));
  expect(room.id).toBeTruthy();
  expect((await post(`/api/v1/rooms/${room.id}/recipients`, owner.headers, { name: "Lead", email: "lead@dummy.test" })).status).toBeLessThan(300);
  for (const path of ["publish", "archive", "recipients"]) {
    expect((await post(`/api/v1/rooms/${room.id}/${path}`, viewer.headers, { name: "Pat", email: "pat@dummy.test" })).status, path).toBe(403);
  }
  expect((await api(`/api/v1/rooms/${room.id}`, { method: "PATCH", headers: viewer.headers, json: { title: "x" } })).status).toBe(403);
  expect((await api(`/api/v1/rooms/${room.id}/analytics`, { headers: viewer.headers })).status).toBe(403);
  expect((await api(`/api/v1/rooms/${room.id}/analytics`, { headers: owner.headers })).status).toBe(200);

  const content = await json(await post("/api/v1/content", admin.headers, { title: "Pitch", kind: "link", canonical_url: "https://example.com/pitch" }));
  expect((await post(`/api/v1/content/${content.id}/share`, viewer.headers, {})).status).toBe(403);
  expect((await post(`/api/v1/content/${content.id}/share`, owner.headers, {})).status).toBe(201);

  mockVault();
  expect((await post("/api/v1/champvault/assets/asset_v/beam", viewer.headers, {})).status).toBe(403);
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM content_shares WHERE shared_by_user_id = ?").bind(viewer.userId).first<{ n: number }>();
  expect(n!.n).toBe(0);
});
