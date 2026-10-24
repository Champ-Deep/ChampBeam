/**
 * GET /api/v1/{pages,files}/:id/availability: lazy per-item blob check.
 * Fixture boundary: in-memory R2 and D1; the storage outage is a mocked
 * bucket.head throw, not a real R2 failure.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, authedUser, env, json, orgSession } from "./helpers";

afterEach(() => vi.restoreAllMocks());

async function newPage(headers: Record<string, string>) {
  const r = await api("/api/v1/pages", { method: "POST", json: { html: "<html><body>hi</body></html>", title: "Avail" }, headers });
  expect(r.status, await r.clone().text()).toBe(201);
  return (await json(r)).page_id as string;
}

async function newFile(headers: Record<string, string>) {
  const body = "hello";
  const init = await json(await api("/api/v1/files", { method: "POST", json: { filename: "a.txt", content_type: "text/plain", size_bytes: body.length }, headers }));
  expect((await api(init.presigned_put_url, { method: "PUT", body, headers: { "Content-Type": "text/plain" } })).status).toBe(204);
  expect((await api(`/api/v1/files/${init.file_id}/finalize`, { method: "POST", json: {}, headers })).status).toBe(200);
  return init.file_id as string;
}

const key = async (id: string) =>
  (await env.DB.prepare("SELECT storage_key FROM file_assets WHERE id = ?").bind(id).first<{ storage_key: string }>())!.storage_key;
const events = async (id: string) =>
  (await env.DB.prepare("SELECT count(*) AS n FROM click_events WHERE file_id = ?").bind(id).first<{ n: number }>())!.n;

describe.each([
  ["pages", newPage],
  ["files", newFile],
])("%s availability", (kind, make) => {
  const url = (id: string) => `/api/v1/${kind}/${id}/availability`;

  it("available: size + etag, no analytics event, no body read", async () => {
    const { headers } = await authedUser();
    const id = await make(headers);
    const get = vi.spyOn(env.FILES, "get");
    const before = await events(id);
    const r = await api(url(id), { headers });
    expect(r.status).toBe(200);
    const d = await json(r);
    expect(d.status).toBe("available");
    expect(d.size).toBeGreaterThan(0);
    expect(typeof d.etag).toBe("string");
    expect(get).not.toHaveBeenCalled();
    expect(await events(id)).toBe(before);
  });

  it("missing: blob gone, still 200", async () => {
    const { headers } = await authedUser();
    const id = await make(headers);
    await env.FILES.delete(await key(id));
    const r = await api(url(id), { headers });
    expect(r.status).toBe(200);
    expect(await json(r)).toEqual({ status: "missing" });
  });

  it("forbidden: another org's actor gets 403, never the blob state", async () => {
    const { headers } = await authedUser();
    const id = await make(headers);
    const intruder = await orgSession({ role: "admin" });
    expect((await api(url(id), { headers: intruder.headers })).status).toBe(403);
  });

  it("unauthenticated 401, unknown id 404, bad id 400", async () => {
    const { headers } = await authedUser();
    expect((await api(url(crypto.randomUUID()))).status).toBe(401);
    expect((await api(url(crypto.randomUUID()), { headers })).status).toBe(404);
    expect((await api(url("nope"), { headers })).status).toBe(400);
  });

  it("storage_error: bucket throw is 503", async () => {
    const { headers } = await authedUser();
    const id = await make(headers);
    vi.spyOn(env.FILES, "head").mockRejectedValue(new Error("r2 down"));
    const r = await api(url(id), { headers });
    expect(r.status).toBe(503);
    expect(await json(r)).toEqual({ status: "storage_error" });
  });
});
