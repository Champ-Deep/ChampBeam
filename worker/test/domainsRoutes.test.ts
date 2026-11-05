/**
 * Route tests for /api/v1/domains and /api/v1/internal/provisioning.
 * Ports the four internal-API cases of backend/tests/test_domain_provisioning.py
 * (the service-level cases live in domainServices.test.ts) plus coverage of
 * the domains router with Cloudflare mocked at the fetch layer.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, authedUser, createUser, env, json } from "./helpers";
import { getSettings, type Env, type Settings } from "../src/env";

// ---- helpers ---------------------------------------------------------------

/** Patch the live settings the Worker reads (same env object, same isolate). */
const patched: [Settings, Partial<Settings>][] = [];
function setSettings(patch: Partial<Settings>) {
  const s = getSettings(env as unknown as Env);
  const saved: Partial<Settings> = {};
  for (const k of Object.keys(patch) as (keyof Settings)[]) (saved as any)[k] = s[k];
  patched.push([s, saved]);
  Object.assign(s, patch);
}
const CF: Partial<Settings> = {
  cloudflareApiToken: "cf-token",
  cloudflareZoneId: "zone1",
  cloudflareConfigured: true,
  cloudflareCnameTarget: "cname.platform.example",
};

afterEach(() => {
  while (patched.length) {
    const [s, saved] = patched.pop()!;
    Object.assign(s, saved);
  }
  vi.restoreAllMocks();
});

const jsonResp = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

type Call = { url: string; method: string };
function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, method: (init?.method ?? "GET").toUpperCase() });
    return handler(url, init);
  });
  return calls;
}

const host = () => `track-${crypto.randomUUID().slice(0, 8)}.example.com`;

async function makeDomain(opts: { userId?: string; status?: string; cfId?: string | null; hostname?: string } = {}) {
  const userId = opts.userId ?? (await createUser()).id;
  const id = crypto.randomUUID();
  const hostname = opts.hostname ?? host();
  await env.DB.prepare(
    "INSERT INTO domains (id, user_id, hostname, status, cf_custom_hostname_id, is_primary, created_at, provision_attempts, auto_renew) VALUES (?,?,?,?,?,0,?,0,0)",
  )
    .bind(id, userId, hostname, opts.status ?? "pending_cname", opts.cfId ?? null, new Date().toISOString())
    .run();
  return { id, hostname, userId };
}

const domainRow = (id: string) =>
  env.DB.prepare("SELECT * FROM domains WHERE id = ?").bind(id).first<Record<string, any>>();

// ---- internal provisioning API (test_domain_provisioning.py) ---------------

describe("internal provisioning API", () => {
  const headers = { "X-Provisioner-Token": "secret-token" };

  it("404 without a configured token", async () => {
    setSettings({ provisionerToken: "" });
    const res = await api("/api/v1/internal/provisioning/domains", { headers: { "X-Provisioner-Token": "anything" } });
    expect(res.status).toBe(404);
  });

  it("401 with the wrong token", async () => {
    setSettings({ provisionerToken: "secret-token" });
    const res = await api("/api/v1/internal/provisioning/domains", { headers: { "X-Provisioner-Token": "wrong" } });
    expect(res.status).toBe(401);
    expect(await json(res)).toEqual({ detail: "Invalid provisioner token" });
  });

  it("lists pending_ssl domains and resolves a success report", async () => {
    setSettings({ provisionerToken: "secret-token" });
    const domain = await makeDomain({ status: "pending_ssl" });

    const listed = await api("/api/v1/internal/provisioning/domains", { headers });
    expect(listed.status).toBe(200);
    const jobs = await json<any[]>(listed);
    expect(jobs.some((j) => j.id === domain.id && j.hostname === domain.hostname && j.attempts === 0)).toBe(true);

    mockFetch((url) =>
      url === `https://${domain.hostname}/health` ? jsonResp({ status: "healthy" }) : jsonResp({}, 404),
    );
    const result = await api(`/api/v1/internal/provisioning/domains/${domain.id}/result`, {
      method: "POST",
      json: { ok: true },
      headers,
    });
    expect(result.status).toBe(200);
    expect(await json(result)).toEqual({ status: "active", attempts: 1 });
    const row = await domainRow(domain.id);
    expect(row?.verified_at).toBeTruthy();
    expect(row?.ssl_status).toBe("active");
  });

  it("three failures park the domain and drop it from the work list", async () => {
    setSettings({ provisionerToken: "secret-token" });
    const domain = await makeDomain({ status: "pending_ssl" });
    let body: any;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const res = await api(`/api/v1/internal/provisioning/domains/${domain.id}/result`, {
        method: "POST",
        json: { ok: false, error: "certbot exploded" },
        headers,
      });
      expect(res.status).toBe(200);
      body = await json(res);
      expect(body.attempts).toBe(attempt);
    }
    expect(body.status).toBe("failed");
    const row = await domainRow(domain.id);
    expect(JSON.parse(row!.verification_errors)).toEqual({
      message: "Certificate provisioning failed: certbot exploded",
    });

    const listed = await api("/api/v1/internal/provisioning/domains", { headers });
    expect((await json<any[]>(listed)).every((j) => j.id !== domain.id)).toBe(true);
  });

  it("bad and unknown domain ids", async () => {
    setSettings({ provisionerToken: "secret-token" });
    const bad = await api("/api/v1/internal/provisioning/domains/nope/result", { method: "POST", json: { ok: true }, headers });
    expect(bad.status).toBe(400);
    expect(await json(bad)).toEqual({ detail: "Invalid domain ID" });
    const missing = await api(`/api/v1/internal/provisioning/domains/${crypto.randomUUID()}/result`, {
      method: "POST",
      json: { ok: true },
      headers,
    });
    expect(missing.status).toBe(404);
    expect(await json(missing)).toEqual({ detail: "Domain not found" });
  });
});

// ---- /api/v1/domains --------------------------------------------------------

describe("domains router", () => {
  it("requires auth", async () => {
    const res = await api("/api/v1/domains");
    expect(res.status).toBe(401);
  });

  it("create without Cloudflare: pending, first is primary, duplicates 409, list newest first", async () => {
    const { headers } = await authedUser();
    const h1 = host();
    const first = await api("/api/v1/domains", { method: "POST", json: { hostname: ` ${h1.toUpperCase()}. ` }, headers });
    expect(first.status).toBe(201);
    const b1 = await json(first);
    expect(b1).toMatchObject({
      hostname: h1,
      status: "pending_cname",
      ssl_status: null,
      is_primary: true,
      cloudflare_managed: false,
      procured: false,
      auto_renew: false,
      verified_at: null,
      last_checked_at: null,
      cname_target: null,
    });
    expect(b1.created_at).toMatch(/Z$/);

    const h2 = host();
    const second = await json(await api("/api/v1/domains", { method: "POST", json: { hostname: h2 }, headers }));
    expect(second.is_primary).toBe(false);

    const dup = await api("/api/v1/domains", { method: "POST", json: { hostname: h1 }, headers });
    expect(dup.status).toBe(409);
    expect(await json(dup)).toEqual({ detail: "This hostname is already registered." });

    const listed = await json<any[]>(await api("/api/v1/domains", { headers }));
    expect(listed.map((d) => d.hostname)).toEqual([h2, h1]);
  });

  it("rejects bad and platform hostnames", async () => {
    const { headers } = await authedUser();
    const bad = await api("/api/v1/domains", { method: "POST", json: { hostname: "-bad-.example.com" }, headers });
    expect(bad.status).toBe(400);
    expect(await json(bad)).toEqual({ detail: "Invalid hostname format." });
    const single = await api("/api/v1/domains", { method: "POST", json: { hostname: "localhost" }, headers });
    expect(single.status).toBe(400);
    const reserved = await api("/api/v1/domains", { method: "POST", json: { hostname: "share.example.com" }, headers });
    expect(reserved.status).toBe(400);
    expect(await json(reserved)).toEqual({ detail: "This hostname is reserved by the platform." });
    const short = await api("/api/v1/domains", { method: "POST", json: { hostname: "a" }, headers });
    expect(short.status).toBe(422);
  });

  it("platform subdomains are active immediately", async () => {
    setSettings({ platformSubdomainBase: "deependhq.com" });
    const { headers } = await authedUser();
    const res = await api("/api/v1/domains", { method: "POST", json: { hostname: "acme.deependhq.com" }, headers });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.status).toBe("active");
    expect(body.ssl_status).toBe("active");
    expect(body.verified_at).toBeTruthy();

    const cfg = await json(await api("/api/v1/domains/config", { headers }));
    expect(cfg).toEqual({
      subdomain_enabled: true,
      platform_subdomain_base: "deependhq.com",
      byod_enabled: false,
      cname_target: null,
      procurement_enabled: false,
    });
  });

  it("create with Cloudflare provisions a custom hostname; CF errors are 502", async () => {
    setSettings(CF);
    const { headers } = await authedUser();
    const calls = mockFetch((url, init) => {
      if (url.endsWith("/zones/zone1/custom_hostnames") && init?.method === "POST") {
        const { hostname } = JSON.parse(String(init.body));
        if (hostname.startsWith("boom")) return jsonResp({ success: false, errors: [{ message: "nope" }] }, 400);
        return jsonResp({ success: true, result: { id: "ch_1", status: "pending", ssl: { status: "pending_validation" } } });
      }
      return jsonResp({}, 404);
    });
    const res = await api("/api/v1/domains", { method: "POST", json: { hostname: host() }, headers });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body).toMatchObject({
      status: "pending_cname",
      ssl_status: "pending_validation",
      cloudflare_managed: true,
      cname_target: "cname.platform.example",
    });
    expect(body.last_checked_at).toBeTruthy();
    expect(calls[0].method).toBe("POST");

    const boom = await api("/api/v1/domains", { method: "POST", json: { hostname: "boom.example.com" }, headers });
    expect(boom.status).toBe(502);
    expect((await json(boom)).detail).toMatch(/^Cloudflare error: /);
  });

  it("refresh polls Cloudflare for CF-managed domains", async () => {
    setSettings(CF);
    const { user, headers } = await authedUser();
    const d = await makeDomain({ userId: user.id, cfId: "ch_9" });
    mockFetch((url) =>
      url.endsWith("/custom_hostnames/ch_9")
        ? jsonResp({ success: true, result: { id: "ch_9", status: "active", ssl: { status: "active" } } })
        : jsonResp({}, 404),
    );
    const res = await api(`/api/v1/domains/${d.id}/refresh`, { method: "POST", headers });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.status).toBe("active");
    expect(body.verified_at).toBeTruthy();
    expect((await domainRow(d.id))?.status).toBe("active");
  });

  it("refresh of a local domain checks reachability", async () => {
    const { user, headers } = await authedUser();
    const d = await makeDomain({ userId: user.id });
    mockFetch((url) => (url === `https://${d.hostname}/health` ? jsonResp({ status: "healthy" }) : jsonResp({}, 404)));
    const body = await json(await api(`/api/v1/domains/${d.id}/refresh`, { method: "POST", headers }));
    expect(body.status).toBe("active");
    expect(body.verification_errors).toBeNull();
  });

  it("refresh: bad id 400, someone else's domain 404", async () => {
    const { headers } = await authedUser();
    const bad = await api("/api/v1/domains/not-a-uuid/refresh", { method: "POST", headers });
    expect(bad.status).toBe(400);
    expect(await json(bad)).toEqual({ detail: "Invalid domain ID." });
    const other = await makeDomain();
    const res = await api(`/api/v1/domains/${other.id}/refresh`, { method: "POST", headers });
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ detail: "Domain not found." });
  });

  it("set-primary requires an active domain and moves the flag", async () => {
    const { user, headers } = await authedUser();
    const pending = await makeDomain({ userId: user.id });
    const a = await makeDomain({ userId: user.id, status: "active" });
    const b = await makeDomain({ userId: user.id, status: "active" });

    const rejected = await api(`/api/v1/domains/${pending.id}/set-primary`, { method: "POST", headers });
    expect(rejected.status).toBe(400);
    expect(await json(rejected)).toEqual({ detail: "Only active domains can be set as primary." });

    expect((await json(await api(`/api/v1/domains/${a.id}/set-primary`, { method: "POST", headers }))).is_primary).toBe(true);
    const res = await api(`/api/v1/domains/${b.id}/set-primary`, { method: "POST", headers });
    expect((await json(res)).is_primary).toBe(true);
    expect((await domainRow(a.id))?.is_primary).toBe(0);
    expect((await domainRow(b.id))?.is_primary).toBe(1);
  });

  it("delete refuses while links use the domain unless forced, and cleans up CF", async () => {
    setSettings(CF);
    const { user, headers } = await authedUser();
    const d = await makeDomain({ userId: user.id, cfId: "ch_del" });
    await env.DB.prepare("INSERT INTO link_clicks (id, user_id, domain_id, original_url, created_at) VALUES (?,?,?,?,?)")
      .bind(crypto.randomUUID(), user.id, d.id, "https://example.com", new Date().toISOString())
      .run();
    const calls = mockFetch((url, init) =>
      url.endsWith("/custom_hostnames/ch_del") && init?.method === "DELETE"
        ? jsonResp({ success: true, result: { id: "ch_del" } })
        : jsonResp({}, 404),
    );

    const refused = await api(`/api/v1/domains/${d.id}`, { method: "DELETE", headers });
    expect(refused.status).toBe(409);
    expect(await json(refused)).toEqual({
      detail: "1 link(s) still use this domain. Pass force=true to delete anyway.",
    });

    const forced = await api(`/api/v1/domains/${d.id}?force=true`, { method: "DELETE", headers });
    expect(forced.status).toBe(204);
    expect(await forced.text()).toBe("");
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
    expect(await domainRow(d.id)).toBeNull();
  });

  it("health reports not_configured without Cloudflare", async () => {
    const { user, headers } = await authedUser();
    const d = await makeDomain({ userId: user.id });
    const body = await json(await api("/api/v1/domains/health", { headers }));
    expect(body.cloudflare_configured).toBe(false);
    expect(body.domains).toEqual([
      {
        id: d.id,
        hostname: d.hostname,
        status: "pending_cname",
        is_primary: false,
        cf_managed: false,
        ssl_status: null,
        verification_errors: null,
        cf_status: "not_configured",
      },
    ]);
  });

  it("procurement endpoints are 503 when the registrar is not configured", async () => {
    const { headers } = await authedUser();
    const search = await api("/api/v1/domains/search?q=acme", { headers });
    expect(search.status).toBe(503);
    const check = await api("/api/v1/domains/check", { method: "POST", json: { domains: ["acme.com"] }, headers });
    expect(check.status).toBe(503);
    const missingQ = await api("/api/v1/domains/search", { headers });
    expect(missingQ.status).toBe(422);
  });
});
