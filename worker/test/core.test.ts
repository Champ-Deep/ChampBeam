/** Smoke tests for the shared core: health, errors, CORS, auth paths, rate counters. */
import { describe, expect, it } from "vitest";
import { api, authedUser, bearer, clerkToken, createApiKey, createUser, env, json, sessionHeaders } from "./helpers";
import { incrWithTtl } from "../src/lib/ratelimit";

describe("core", () => {
  it("health reports the database", async () => {
    const res = await api("/health");
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ status: "healthy", database: "connected" });
  });

  it("unknown API paths return FastAPI's 404 body", async () => {
    const res = await api("/api/v1/does-not-exist");
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ detail: "Not Found" });
  });

  it("CORS: allowed origin echoed, preflight answered, unknown origin ignored", async () => {
    const ok = await api("/health", { headers: { Origin: "http://localhost:5173" } });
    expect(ok.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    const preview = await api("/health", { headers: { Origin: "https://champbeam-git-x-deep.vercel.app" } });
    expect(preview.headers.get("access-control-allow-origin")).toBe("https://champbeam-git-x-deep.vercel.app");
    const pre = await api("/api/v1/utm/generate", {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:5173", "Access-Control-Request-Method": "POST" },
    });
    expect(pre.status).toBe(200);
    expect(pre.headers.get("access-control-allow-methods")).toContain("POST");
    const bad = await api("/health", { headers: { Origin: "https://evil.example" } });
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("rate counters increment within a window and fail open semantics hold", async () => {
    expect(await incrWithTtl(env.DB, "k1", 60)).toBe(1);
    expect(await incrWithTtl(env.DB, "k1", 60)).toBe(2);
    expect(await incrWithTtl(env.DB, "k2", 60)).toBe(1);
  });
});

describe("auth", () => {
  it("an invalid API key is a 401 even on optional-auth paths", async () => {
    const res = await api("/api/v1/auth/me", { headers: { "X-API-Key": "cb_live_nope" } });
    expect(res.status).toBe(401);
    expect(await json(res)).toEqual({ detail: "Invalid API key" });
  });

  it("a valid API key resolves its user", async () => {
    const { user, headers } = await authedUser({ email: "keyed@example.com" });
    const res = await api("/api/v1/auth/me", { headers });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.email).toBe("keyed@example.com");
    expect(body.user_id).toBe(user.id);
  });

  it("a revoked API key is rejected", async () => {
    const user = await createUser();
    const raw = await createApiKey(user.id);
    await env.DB.prepare("UPDATE api_keys SET revoked_at = ?").bind(new Date().toISOString()).run();
    const res = await api("/api/v1/auth/me", { headers: { "X-API-Key": raw } });
    expect(res.status).toBe(401);
  });

  it("PUT /auth/profile cannot self-assert an email (e.g. claim the service+<name> identity); name still updates", async () => {
    const { user, headers } = await authedUser();
    const bad = await api("/api/v1/auth/profile", { method: "PUT", json: { email: "service+composer@championsmail.com" }, headers });
    expect(bad.status).toBe(400);
    const ok = await api("/api/v1/auth/profile", { method: "PUT", json: { full_name: "Ada", email: user.email }, headers });
    expect(ok.status).toBe(200);
    const row = await env.DB.prepare("SELECT email, full_name FROM users WHERE id = ?").bind(user.id).first();
    expect(row).toEqual({ email: user.email, full_name: "Ada" });
  });

  it("a tampered session cookie or an expired session is a 401", async () => {
    const user = await createUser();
    const { Cookie } = await sessionHeaders(user.id);
    expect((await api("/api/v1/auth/me", { headers: { Cookie } })).status).toBe(200);
    const tampered = Cookie.slice(0, -8) + (Cookie.endsWith("AAAAAAAA") ? "BBBBBBBB" : "AAAAAAAA");
    expect((await api("/api/v1/auth/me", { headers: { Cookie: tampered } })).status).toBe(401);
    await env.DB.prepare("UPDATE session SET expires_at = ? WHERE user_id = ?").bind(Date.now() - 1000, user.id).run();
    expect((await api("/api/v1/auth/me", { headers: { Cookie } })).status).toBe(401);
  });

  it("a leftover Clerk session JWT in Authorization is a 401, not a session", async () => {
    const token = await clerkToken({ sub: "user_jwt2" });
    const res = await api("/api/v1/auth/me", { headers: bearer(token) });
    expect(res.status).toBe(401);
    expect(await json(res)).toEqual({ detail: "Could not validate credentials" });
  });

  it("service keys: bad key 401, off-allowlist route 403", async () => {
    const bad = await api("/api/v1/utm/generate", { method: "POST", headers: { "X-Service-Key": "nope" } });
    expect(bad.status).toBe(401);
    const off = await api("/api/v1/auth/me", { headers: { "X-Service-Key": "svc-test-key" } });
    expect(off.status).toBe(403);
    expect(await json(off)).toEqual({ detail: "Service keys are not accepted on this endpoint" });
  });
});
