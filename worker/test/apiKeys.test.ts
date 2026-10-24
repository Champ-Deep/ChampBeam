/**
 * API-key auth and /api/v1/api-keys management. Port of backend/tests/test_api_keys.py.
 *
 * The Python cases that exercised API keys against /utm and /projects use
 * GET /api/v1/domains here (another require_auth endpoint) — the behaviour
 * under test is key resolution in auth/security.ts, not those routers.
 */
import { describe, expect, it } from "vitest";
import { api, bearer, clerkToken, createApiKey, createUser, env, json, sha256Hex } from "./helpers";
import { windowIndex } from "../src/lib/ratelimit";

const PREFIX = "cb_live_";

async function mintKey(opts: { revoked?: boolean; expired?: boolean } = {}) {
  const user = await createUser();
  const raw = await createApiKey(user.id);
  const hash = await sha256Hex(raw);
  if (opts.revoked) {
    await env.DB.prepare("UPDATE api_keys SET revoked_at = ? WHERE key_hash = ?").bind(new Date().toISOString(), hash).run();
  }
  if (opts.expired) {
    await env.DB.prepare("UPDATE api_keys SET expires_at = ? WHERE key_hash = ?")
      .bind(new Date(Date.now() - 60_000).toISOString(), hash)
      .run();
  }
  const row = await env.DB.prepare("SELECT id FROM api_keys WHERE key_hash = ?").bind(hash).first<{ id: string }>();
  return { raw, user, keyId: row!.id };
}

describe("API key auth (test_api_keys.py)", () => {
  it("authenticates via X-API-Key and via Bearer", async () => {
    // test_generate_link_with_api_key_header / _with_bearer_api_key
    const { raw } = await mintKey();
    expect((await api("/api/v1/domains", { headers: { "X-API-Key": raw } })).status).toBe(200);
    expect((await api("/api/v1/domains", { headers: bearer(raw) })).status).toBe(200);
  });

  it("an invalid key is 401, not anonymous", async () => {
    const res = await api("/api/v1/domains", { headers: { "X-API-Key": PREFIX + "definitely-not-a-real-key" } });
    expect(res.status).toBe(401);
  });

  it("revoked and expired keys are rejected", async () => {
    for (const opts of [{ revoked: true }, { expired: true }]) {
      const { raw } = await mintKey(opts);
      const res = await api("/api/v1/domains", { headers: { "X-API-Key": raw } });
      expect(res.status, JSON.stringify(opts)).toBe(401);
    }
  });

  it("a key reads the integration surface", async () => {
    const { raw } = await mintKey();
    const res = await api("/api/v1/domains", { headers: { "X-API-Key": raw } });
    expect(res.status).toBe(200);
  });

  it("an API key cannot manage keys", async () => {
    const { raw } = await mintKey();
    const list = await api("/api/v1/api-keys", { headers: { "X-API-Key": raw } });
    expect(list.status).toBe(403);
    expect(await json(list)).toEqual({ detail: "API keys cannot access this endpoint; sign in required" });
    const create = await api("/api/v1/api-keys", { method: "POST", json: { name: "sneaky" }, headers: { "X-API-Key": raw } });
    expect(create.status).toBe(403);
    expect((await api("/api/v1/api-keys", { headers: bearer(raw) })).status).toBe(403);
  });

  it("management requires authentication", async () => {
    expect((await api("/api/v1/api-keys")).status).toBe(401);
  });

  it("key management with a Clerk session", async () => {
    const sub = `user_${crypto.randomUUID().slice(0, 12)}`;
    const headers = bearer(await clerkToken({ sub, email: `${sub}@example.com` }));

    const created = await api("/api/v1/api-keys", { method: "POST", json: { name: " ci key " }, headers });
    expect(created.status).toBe(201);
    const body = await json(created);
    expect(body.api_key.startsWith(PREFIX)).toBe(true);
    expect(body.key_prefix).toBe(body.api_key.slice(0, 12));
    expect(body.name).toBe("ci key");
    expect(body.revoked_at).toBeNull();
    expect(body.last_used_at).toBeNull();
    expect(body.created_at).not.toMatch(/Z$/); // naive datetime, like Pydantic
    const keyId = body.id;

    // The freshly minted key authenticates as its owner.
    expect((await api("/api/v1/domains", { headers: { "X-API-Key": body.api_key } })).status).toBe(200);

    const listed = await api("/api/v1/api-keys", { headers });
    expect(listed.status).toBe(200);
    const keys = await json<any[]>(listed);
    expect(keys.map((k) => k.id)).toEqual([keyId]);
    expect("api_key" in keys[0]).toBe(false); // full key never shown again

    const revoked = await api(`/api/v1/api-keys/${keyId}/revoke`, { method: "POST", headers });
    expect(revoked.status).toBe(200);
    const revokedAt = (await json(revoked)).revoked_at;
    expect(revokedAt).not.toBeNull();

    // Revoking again is idempotent; DELETE is an alias.
    const again = await api(`/api/v1/api-keys/${keyId}`, { method: "DELETE", headers });
    expect(again.status).toBe(200);
    expect((await json(again)).revoked_at).toBe(revokedAt);

    const rejected = await api("/api/v1/domains", { headers: { "X-API-Key": body.api_key } });
    expect(rejected.status).toBe(401);
  });

  it("unknown, malformed and foreign key ids are 404", async () => {
    const sub = `user_${crypto.randomUUID().slice(0, 12)}`;
    const headers = bearer(await clerkToken({ sub }));
    const { keyId: foreign } = await mintKey();
    for (const id of ["not-a-uuid", crypto.randomUUID(), foreign]) {
      const res = await api(`/api/v1/api-keys/${id}/revoke`, { method: "POST", headers });
      expect(res.status, id).toBe(404);
      expect(await json(res)).toEqual({ detail: "API key not found" });
    }
  });

  it("caps active keys at 10", async () => {
    const sub = `user_${crypto.randomUUID().slice(0, 12)}`;
    const headers = bearer(await clerkToken({ sub }));
    for (let i = 0; i < 10; i++) {
      expect((await api("/api/v1/api-keys", { method: "POST", json: { name: `k${i}` }, headers })).status).toBe(201);
    }
    const res = await api("/api/v1/api-keys", { method: "POST", json: { name: "k10" }, headers });
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ detail: "Limit of 10 active API keys reached; revoke one first" });
    const empty = await api("/api/v1/api-keys", { method: "POST", json: { name: "" }, headers });
    expect(empty.status).toBe(422);
  });

  it("429 when the per-key rate counter is over the limit", async () => {
    const { raw, keyId } = await mintKey();
    // Seed this window and the next so a minute boundary can't flake the test.
    const window = windowIndex(60);
    for (const w of [window, window + 1]) {
      await env.DB.prepare("INSERT INTO rate_counters (key, count, expires_at) VALUES (?, ?, ?)")
        .bind(`api_rl:${keyId}:${w}`, 120, Math.floor(Date.now() / 1000) + 180)
        .run();
    }
    const res = await api("/api/v1/domains", { headers: { "X-API-Key": raw } });
    expect(res.status).toBe(429);
  });
});
