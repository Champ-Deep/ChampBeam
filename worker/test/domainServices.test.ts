/**
 * Custom-domain services: CF for SaaS client, Registrar client, BYOD state
 * machine and the cron refresh. Port of backend/tests/test_domain_provisioning.py
 * (service-level cases; the internal provisioning API cases live with that
 * router's tests) plus direct coverage of the clients.
 */
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createUser, env } from "./helpers";
import { buildSettings, type Env } from "../src/env";
import { getDb } from "../src/db/client";
import {
  DOMAIN_STATUS_ACTIVE,
  DOMAIN_STATUS_FAILED,
  DOMAIN_STATUS_PENDING_CNAME,
  DOMAIN_STATUS_PENDING_SSL,
  domains,
} from "../src/db/schema";
import * as cf from "../src/services/cloudflare";
import * as reg from "../src/services/cloudflareRegistrar";
import * as dp from "../src/services/domainProvisioning";

const settingsWith = (vars: Record<string, string>) => buildSettings({ ...(env as unknown as Env), ...vars });
const BYOD = { PLATFORM_IPV4: "64.227.154.215", BYOD_CNAME_TARGET: "origin.example.com" };
const CF = { CLOUDFLARE_API_TOKEN: "cf-token", CLOUDFLARE_ZONE_ID: "zone1", CLOUDFLARE_ACCOUNT_ID: "acct1" };

type Call = { url: string; init?: RequestInit };
function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    return handler(url, init);
  });
  return { fetch, calls };
}
const jsonResp = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function makeDomain(opts: { status?: string; cfId?: string | null; createdAt?: string } = {}) {
  const user = await createUser();
  const db = getDb(env.DB);
  const [row] = await db
    .insert(domains)
    .values({
      userId: user.id,
      hostname: `track-${crypto.randomUUID().slice(0, 8)}.example.com`,
      status: opts.status ?? DOMAIN_STATUS_PENDING_CNAME,
      cfCustomHostnameId: opts.cfId ?? null,
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    })
    .returning();
  return row;
}

const nope = async () => false;
const yes = async () => true;

describe("domain_provisioning state machine (test_domain_provisioning.py)", () => {
  it("DNS verified advances to pending_ssl", async () => {
    const settings = settingsWith(BYOD);
    const domain = await makeDomain();
    await dp.applyLocalStatus(domain, settings, { verifyReachable: nope, dnsPointsHere: yes });
    expect(domain.status).toBe(DOMAIN_STATUS_PENDING_SSL);
    expect(domain.provisionRequestedAt).not.toBeNull();
    expect(domain.sslStatus).toBe("provisioning");
  });

  it("no DNS stays pending_cname", async () => {
    const settings = settingsWith(BYOD);
    const domain = await makeDomain();
    await dp.applyLocalStatus(domain, settings, { verifyReachable: nope, dnsPointsHere: nope });
    expect(domain.status).toBe(DOMAIN_STATUS_PENDING_CNAME);
    expect((domain.verificationErrors as { message?: string } | null)?.message ?? "").toContain("CNAME");
  });

  it("reachable goes straight to active", async () => {
    const domain = await makeDomain();
    await dp.applyLocalStatus(domain, settingsWith({}), { verifyReachable: yes });
    expect(domain.status).toBe(DOMAIN_STATUS_ACTIVE);
    expect(domain.verifiedAt).not.toBeNull();
  });

  it("DNS is not consulted when the BYOD path is disabled", async () => {
    const domain = await makeDomain();
    const dns = vi.fn(yes);
    await dp.applyLocalStatus(domain, settingsWith({}), { verifyReachable: nope, dnsPointsHere: dns });
    expect(dns).not.toHaveBeenCalled();
    expect(domain.status).toBe(DOMAIN_STATUS_PENDING_CNAME);
  });

  it("platform subdomains are active without probing", async () => {
    const settings = settingsWith({ PLATFORM_SUBDOMAIN_BASE: ".deependhq.com" });
    const domain = { ...(await makeDomain()), hostname: "acme.deependhq.com" };
    const probe = vi.fn(nope);
    await dp.applyLocalStatus(domain, settings, { verifyReachable: probe });
    expect(probe).not.toHaveBeenCalled();
    expect(domain.status).toBe(DOMAIN_STATUS_ACTIVE);
    expect(domain.sslStatus).toBe("active");
  });

  it("isPlatformSubdomain only matches single-label children of the base", () => {
    const s = { platformSubdomainBase: "DeependHQ.com" };
    expect(dp.isPlatformSubdomain("acme.deependhq.com", s)).toBe(true);
    expect(dp.isPlatformSubdomain("deependhq.com", s)).toBe(false);
    expect(dp.isPlatformSubdomain("a.b.deependhq.com", s)).toBe(false);
    expect(dp.isPlatformSubdomain("acmedeependhq.com", s)).toBe(false);
    expect(dp.isPlatformSubdomain("acme.deependhq.com", { platformSubdomainBase: "" })).toBe(false);
  });

  it("MAX_PROVISION_ATTEMPTS is 3", () => {
    expect(dp.MAX_PROVISION_ATTEMPTS).toBe(3);
  });
});

describe("probes", () => {
  it("verifyReachable requires a 200 with the health signature", async () => {
    const ok = mockFetch(() => jsonResp({ status: "healthy" }));
    expect(await dp.verifyReachable("x.example.com", { fetch: ok.fetch })).toBe(true);
    expect(ok.calls[0].url).toBe("https://x.example.com/health");
    expect(await dp.verifyReachable("x.example.com", { fetch: mockFetch(() => jsonResp({ status: "nope" })).fetch })).toBe(false);
    expect(await dp.verifyReachable("x.example.com", { fetch: mockFetch(() => jsonResp({}, 502)).fetch })).toBe(false);
    expect(await dp.verifyReachable("x.example.com", { fetch: mockFetch(() => new Response("<html>")).fetch })).toBe(false);
    const boom = mockFetch(() => {
      throw new TypeError("network");
    });
    expect(await dp.verifyReachable("x.example.com", { fetch: boom.fetch })).toBe(false);
  });

  it("dnsPointsHere follows the CNAME chain via DoH", async () => {
    const settings = settingsWith(BYOD);
    const m = mockFetch(() =>
      jsonResp({
        Status: 0,
        Answer: [
          { name: "track.acme.com.", type: 5, data: "origin.example.com." },
          { name: "origin.example.com.", type: 1, data: "64.227.154.215" },
        ],
      }),
    );
    expect(await dp.dnsPointsHere("track.acme.com", settings, { fetch: m.fetch })).toBe(true);
    expect(m.calls[0].url).toBe("https://cloudflare-dns.com/dns-query?name=track.acme.com&type=A");
    expect(new Headers(m.calls[0].init?.headers).get("accept")).toBe("application/dns-json");
  });

  it("dnsPointsHere is false for other IPs, NXDOMAIN, or no PLATFORM_IPV4", async () => {
    const settings = settingsWith(BYOD);
    const other = mockFetch(() => jsonResp({ Status: 0, Answer: [{ type: 1, data: "1.2.3.4" }] }));
    expect(await dp.dnsPointsHere("a.com", settings, { fetch: other.fetch })).toBe(false);
    const nx = mockFetch(() => jsonResp({ Status: 3 }));
    expect(await dp.dnsPointsHere("a.com", settings, { fetch: nx.fetch })).toBe(false);
    expect(nx.calls).toHaveLength(1);
    const never = mockFetch(() => jsonResp({}));
    expect(await dp.dnsPointsHere("a.com", settingsWith({}), { fetch: never.fetch })).toBe(false);
    expect(never.calls).toHaveLength(0);
  });

  it("dnsPointsHere falls back to the second resolver on resolver failure", async () => {
    const m = mockFetch((url) =>
      url.startsWith("https://cloudflare-dns.com")
        ? jsonResp({}, 503)
        : jsonResp({ Status: 0, Answer: [{ type: 1, data: "64.227.154.215" }] }),
    );
    expect(await dp.dnsPointsHere("a.com", settingsWith(BYOD), { fetch: m.fetch })).toBe(true);
    expect(m.calls[1].url).toContain("https://dns.google/resolve?name=a.com&type=A");
  });
});

describe("cloudflare (CF for SaaS client)", () => {
  it("not configured raises CloudflareNotConfigured", async () => {
    await expect(cf.getCustomHostname(settingsWith({}), "x")).rejects.toBeInstanceOf(cf.CloudflareNotConfigured);
  });

  it("createCustomHostname posts the DV/http SSL body and unwraps result", async () => {
    const m = mockFetch(() => jsonResp({ success: true, result: { id: "ch1", status: "pending" } }));
    const res = await cf.createCustomHostname(settingsWith(CF), "track.acme.com", { fetch: m.fetch });
    expect(res).toEqual({ id: "ch1", status: "pending" });
    expect(m.calls[0].url).toBe(`${cf.API_BASE}/zones/zone1/custom_hostnames`);
    expect(m.calls[0].init?.method).toBe("POST");
    expect(new Headers(m.calls[0].init?.headers).get("authorization")).toBe("Bearer cf-token");
    expect(JSON.parse(String(m.calls[0].init?.body))).toEqual({
      hostname: "track.acme.com",
      ssl: { method: "http", type: "dv", settings: { min_tls_version: "1.2" } },
    });
  });

  it("errors surface as CloudflareError (API error, success=false, non-JSON)", async () => {
    const s = settingsWith(CF);
    const apiErr = mockFetch(() => jsonResp({ success: false, errors: [{ code: 1406, message: "dup" }] }, 409));
    await expect(cf.createCustomHostname(s, "a.com", { fetch: apiErr.fetch })).rejects.toThrow(/create_custom_hostname\(a\.com\).*dup/);
    const notOk = mockFetch(() => jsonResp({ success: false, errors: [] }));
    await expect(cf.getCustomHostname(s, "id1", { fetch: notOk.fetch })).rejects.toBeInstanceOf(cf.CloudflareError);
    const html = mockFetch(() => new Response("<html>", { status: 502 }));
    await expect(cf.getCustomHostname(s, "id1", { fetch: html.fetch })).rejects.toThrow("get_custom_hostname(id1): non-JSON response (HTTP 502)");
  });

  it("deleteCustomHostname treats 404 as success", async () => {
    const s = settingsWith(CF);
    const gone = mockFetch(() => new Response("not found", { status: 404 }));
    await expect(cf.deleteCustomHostname(s, "id1", { fetch: gone.fetch })).resolves.toBeUndefined();
    expect(gone.calls[0].init?.method).toBe("DELETE");
    const fail = mockFetch(() => jsonResp({ success: false, errors: [{ message: "x" }] }, 500));
    await expect(cf.deleteCustomHostname(s, "id1", { fetch: fail.fetch })).rejects.toBeInstanceOf(cf.CloudflareError);
  });

  it("deriveStatus collapses hostname + ssl status", () => {
    expect(cf.deriveStatus({ status: "active", ssl: { status: "active" } })).toEqual(["active", "active"]);
    expect(cf.deriveStatus({ status: "active", ssl: { status: "pending_validation" } })).toEqual(["pending_ssl", "pending_validation"]);
    expect(cf.deriveStatus({ status: "pending" })).toEqual(["pending_cname", null]);
    expect(cf.deriveStatus({ status: "Moved", ssl: { status: "active" } })).toEqual(["failed", "active"]);
    expect(cf.deriveStatus({})).toEqual(["pending_cname", null]);
  });
});

describe("cloudflareRegistrar", () => {
  it("not configured raises RegistrarNotConfigured", async () => {
    await expect(reg.search(settingsWith({}), "acme")).rejects.toBeInstanceOf(reg.RegistrarNotConfigured);
  });

  it("search / check / register hit the account endpoints", async () => {
    const s = settingsWith(CF);
    const m = mockFetch((url) => {
      if (url.includes("domain-search")) return jsonResp({ success: true, result: { domains: [{ name: "acme.com" }] } });
      if (url.includes("domain-check")) return jsonResp({ result: { domains: [{ name: "acme.com", available: true }] } });
      return jsonResp({ success: true, result: { state: "succeeded", completed: true } });
    });
    expect(await reg.search(s, "acme", 5, { fetch: m.fetch })).toEqual([{ name: "acme.com" }]);
    expect(m.calls[0].url).toBe(`${cf.API_BASE}/accounts/acct1/registrar/domain-search?q=acme&limit=5`);

    const names = Array.from({ length: 25 }, (_, i) => `d${i}.com`);
    expect(await reg.check(s, names, { fetch: m.fetch })).toEqual([{ name: "acme.com", available: true }]);
    expect(JSON.parse(String(m.calls[1].init?.body)).domains).toHaveLength(20);

    await reg.register(s, "acme.com", { autoRenew: true }, { fetch: m.fetch });
    expect(m.calls[2].url).toBe(`${cf.API_BASE}/accounts/acct1/registrar/registrations`);
    expect(JSON.parse(String(m.calls[2].init?.body))).toEqual({ domain_name: "acme.com", auto_renew: true });
    await reg.register(s, "acme.com", { contacts: { email: "a@b.c" } }, { fetch: m.fetch });
    expect(JSON.parse(String(m.calls[3].init?.body)).contacts).toEqual({ email: "a@b.c" });
  });

  it("findZoneId and createCname", async () => {
    const s = settingsWith(CF);
    const m = mockFetch((url) =>
      url.includes("/dns_records") ? jsonResp({ success: true, result: { id: "rec1" } }) : jsonResp({ success: true, result: [{ id: "z9" }] }),
    );
    expect(await reg.findZoneId(s, "acme.com", { fetch: m.fetch })).toBe("z9");
    expect(m.calls[0].url).toBe(`${cf.API_BASE}/zones?name=acme.com&account.id=acct1`);
    await reg.createCname(s, "z9", "acme.com", "share.example.com", true, { fetch: m.fetch });
    expect(JSON.parse(String(m.calls[1].init?.body))).toEqual({
      type: "CNAME",
      name: "acme.com",
      content: "share.example.com",
      proxied: true,
      ttl: 1,
    });
    const empty = mockFetch(() => jsonResp({ success: true, result: [] }));
    expect(await reg.findZoneId(s, "none.com", { fetch: empty.fetch })).toBeNull();
    const bad = mockFetch(() => jsonResp({ success: false, errors: [{ message: "denied" }] }, 403));
    await expect(reg.findZoneId(s, "x.com", { fetch: bad.fetch })).rejects.toBeInstanceOf(reg.RegistrarError);
  });

  it("deriveRegistrationState", () => {
    expect(reg.deriveRegistrationState({ completed: true })).toBe("succeeded");
    expect(reg.deriveRegistrationState({ completed: true, state: "Succeeded" })).toBe("succeeded");
    expect(reg.deriveRegistrationState({ completed: true, state: "failed" })).toBe("failed");
    expect(reg.deriveRegistrationState({ state: "action_required" })).toBe("action_required");
    expect(reg.deriveRegistrationState({})).toBe("in_progress");
  });
});

describe("applyCfStatus", () => {
  it("mirrors CF status, sets verified_at on active, records failures", async () => {
    const s = settingsWith(CF);
    const d = await makeDomain({ cfId: "ch1" });
    await dp.applyCfStatus(d, s, { fetch: mockFetch(() => jsonResp({ success: true, result: { status: "active", ssl: { status: "active" } } })).fetch });
    expect(d.status).toBe(DOMAIN_STATUS_ACTIVE);
    expect(d.verifiedAt).not.toBeNull();
    expect(d.verificationErrors).toBeNull();

    const failed = await makeDomain({ cfId: "ch2" });
    const cfResult = { status: "deleted", ssl: { status: "deleted" } };
    await dp.applyCfStatus(failed, s, { fetch: mockFetch(() => jsonResp({ success: true, result: cfResult })).fetch });
    expect(failed.status).toBe(DOMAIN_STATUS_FAILED);
    expect(failed.verificationErrors).toEqual({ cf: cfResult });

    const errored = await makeDomain({ cfId: "ch3", status: DOMAIN_STATUS_PENDING_SSL });
    await dp.applyCfStatus(errored, s, { fetch: mockFetch(() => jsonResp({ success: false, errors: [{ message: "rate" }] }, 429)).fetch });
    expect(errored.status).toBe(DOMAIN_STATUS_PENDING_SSL);
    expect((errored.verificationErrors as { message: string }).message).toContain("rate");
    expect(errored.lastCheckedAt).not.toBeNull();
  });

  it("is a no-op when CF is not configured or the domain is not CF-managed", async () => {
    const d = await makeDomain({ cfId: "ch1" });
    const m = mockFetch(() => jsonResp({}));
    await dp.applyCfStatus(d, settingsWith({}), { fetch: m.fetch });
    const local = await makeDomain();
    await dp.applyCfStatus(local, settingsWith(CF), { fetch: m.fetch });
    expect(m.calls).toHaveLength(0);
    expect(d.lastCheckedAt).toBeNull();
  });
});

describe("refreshPendingDomains (cron, replaces domain_provision_loop)", () => {
  it("refreshes CF-managed and self-hosted pending domains and persists them", async () => {
    const settings = settingsWith({ ...CF, ...BYOD });
    const db = getDb(env.DB);
    const cfDomain = await makeDomain({ cfId: "chX" });
    const local = await makeDomain();
    const stale = await makeDomain({ createdAt: new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString() });
    const done = await makeDomain({ status: DOMAIN_STATUS_ACTIVE });

    const m = mockFetch((url) => {
      if (url.includes("/custom_hostnames/chX"))
        return jsonResp({ success: true, result: { status: "active", ssl: { status: "pending_validation" } } });
      if (url.endsWith("/health")) return new Response("no", { status: 404 });
      if (url.includes("dns-query"))
        return jsonResp({ Status: 0, Answer: [{ type: 1, data: "64.227.154.215" }] });
      return jsonResp({ success: true, result: {} });
    });
    await dp.refreshPendingDomains(env as unknown as Env, settings, db, { fetch: m.fetch });

    const get = async (id: string) => (await db.select().from(domains).where(eq(domains.id, id)))[0];
    const cfRow = await get(cfDomain.id);
    expect(cfRow.status).toBe(DOMAIN_STATUS_PENDING_SSL);
    expect(cfRow.sslStatus).toBe("pending_validation");
    const localRow = await get(local.id);
    expect(localRow.status).toBe(DOMAIN_STATUS_PENDING_SSL);
    expect(localRow.provisionRequestedAt).not.toBeNull();
    expect(localRow.verificationErrors).toEqual({ message: dp.PROVISIONING_MESSAGE });
    expect((await get(stale.id)).lastCheckedAt).toBeNull();
    expect((await get(done.id)).lastCheckedAt).toBeNull();
    // Health probe never went to the CF-managed hostname.
    expect(m.calls.some((c) => c.url === `https://${cfDomain.hostname}/health`)).toBe(false);
  });

  it("skips the self-hosted sweep when BYOD is not configured", async () => {
    const db = getDb(env.DB);
    const local = await makeDomain();
    const m = mockFetch(() => jsonResp({}));
    await dp.refreshPendingDomains(env as unknown as Env, settingsWith({}), db, { fetch: m.fetch });
    expect(m.calls).toHaveLength(0);
    const [row] = await db.select().from(domains).where(eq(domains.id, local.id));
    expect(row.lastCheckedAt).toBeNull();
  });
});
