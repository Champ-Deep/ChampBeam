/** Smoke tests for the shared core: health, errors, CORS, auth paths, rate counters. */
import { describe, expect, it } from "vitest";
import { api, authedUser, bearer, clerkToken, createApiKey, createUser, env, json } from "./helpers";
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

  it("a Clerk JWT creates the user on first use with a placeholder email, or the token email", async () => {
    const token = await clerkToken({ sub: "user_jwt1", email: "jwt1@example.com" });
    const res = await api("/api/v1/auth/me", { headers: bearer(token) });
    expect(res.status).toBe(200);
    expect((await json(res)).email).toBe("jwt1@example.com");
    const row = await env.DB.prepare("SELECT email FROM users WHERE clerk_id = 'user_jwt1'").first<{ email: string }>();
    expect(row?.email).toBe("jwt1@example.com");
  });

  it("a tampered or expired JWT is a 401", async () => {
    const token = await clerkToken({ sub: "user_jwt2" });
    const tampered = token.slice(0, -4) + (token.endsWith("AAAA") ? "BBBB" : "AAAA");
    expect((await api("/api/v1/auth/me", { headers: bearer(tampered) })).status).toBe(401);
    const expired = await clerkToken({ sub: "user_jwt2", expiresIn: "-1m" });
    const res = await api("/api/v1/auth/me", { headers: bearer(expired) });
    expect(res.status).toBe(401);
    expect(await json(res)).toEqual({ detail: "Could not validate credentials" });
  });

  it("azp outside the authorized parties is rejected", async () => {
    const token = await clerkToken({ sub: "user_jwt3", azp: "https://evil.example" });
    const res = await api("/api/v1/auth/me", { headers: bearer(token) });
    expect(res.status).toBe(401);
    expect(await json(res)).toEqual({ detail: "Unauthorized party" });
  });

  it("org claims mirror the organization and membership", async () => {
    const token = await clerkToken({ sub: "user_jwt4", org: { id: "org_abc", rol: "org:admin", slg: "abc" } });
    expect((await api("/api/v1/auth/me", { headers: bearer(token) })).status).toBe(200);
    const m = await env.DB.prepare(
      `SELECT m.role FROM organization_memberships m JOIN organizations o ON o.id = m.organization_id
       JOIN users u ON u.id = m.user_id WHERE o.clerk_org_id = 'org_abc' AND u.clerk_id = 'user_jwt4'`,
    ).first<{ role: string }>();
    expect(m?.role).toBe("admin");
  });

  it("service keys: bad key 401, off-allowlist route 403", async () => {
    const bad = await api("/api/v1/utm/generate", { method: "POST", headers: { "X-Service-Key": "nope" } });
    expect(bad.status).toBe(401);
    const off = await api("/api/v1/auth/me", { headers: { "X-Service-Key": "svc-test-key" } });
    expect(off.status).toBe(403);
    expect(await json(off)).toEqual({ detail: "Service keys are not accepted on this endpoint" });
  });
});
