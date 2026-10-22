/**
 * Geo / client-IP / MaxMind usage / company intent. Ports of
 * backend/tests/test_client_ip.py, test_geoip_ipinfo.py, test_geoip_maxmind_ws.py,
 * test_maxmind_usage.py (service parts) and the resolver half of
 * test_company_intent.py. Outbound HTTPS is mocked by injecting `fetch`.
 */
import { env } from "cloudflare:test";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../src/db/client";
import { buildSettings, type Env } from "../src/env";
import { clientIp, isVpnIp } from "../src/lib/accessControl";
import type { CfGeo } from "../src/lib/request";
import { resolveCompany } from "../src/services/companyIntel";
import * as geo from "../src/services/geoip";
import * as maxmindUsage from "../src/services/maxmindUsage";

const settingsWith = (vars: Record<string, string>) => buildSettings({ ...(env as unknown as Env), ...vars });
const db = () => getDb(env.DB);

type FetchCall = { url: string; init?: RequestInit };
function fakeFetch(handler: (url: string, init?: RequestInit) => unknown, status = 200) {
  const calls: FetchCall[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, init });
    const body = handler(url, init);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetch: f, calls };
}
const failingFetch = (() => {
  throw new Error("provider must not be called");
}) as unknown as typeof fetch;

afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
// test_client_ip.py
// ---------------------------------------------------------------------------
describe("clientIp (access_control.client_ip)", () => {
  const app = new Hono().get("/", (c) => c.json({ ip: clientIp(c) }));
  const ipFor = async (headers: Record<string, string>) =>
    ((await (await app.request("/", { headers })).json()) as { ip: string | null }).ip;

  it("prefers CF-Connecting-IP over the forwarded chain", async () => {
    expect(
      await ipFor({
        "CF-Connecting-IP": "49.205.201.248",
        "X-Forwarded-For": "172.68.147.138, 10.0.0.5",
        "X-Real-IP": "172.68.147.138",
      }),
    ).toBe("49.205.201.248");
  });

  it("uses True-Client-IP when present", async () => {
    expect(await ipFor({ "True-Client-IP": "203.0.113.9", "X-Forwarded-For": "172.68.1.1" })).toBe("203.0.113.9");
  });

  it("falls back to X-Forwarded-For without CDN headers", async () => {
    expect(await ipFor({ "X-Forwarded-For": "24.48.0.1, 10.0.0.5" })).toBe("24.48.0.1");
  });

  it("never lets X-Real-IP outrank X-Forwarded-For", async () => {
    expect(await ipFor({ "X-Real-IP": "172.68.147.138", "X-Forwarded-For": "49.205.201.248" })).toBe("49.205.201.248");
  });

  it("is null when nothing is available (no socket peer on Workers)", async () => {
    expect(await ipFor({})).toBeNull();
    expect(await ipFor({ "X-Real-IP": "172.68.147.138" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// test_geoip_ipinfo.py
// ---------------------------------------------------------------------------
describe("IPinfo provider", () => {
  it("lookupIp uses IPinfo when configured (no request.cf, no MaxMind)", async () => {
    const settings = settingsWith({ IPINFO_API_TOKEN: "tok" });
    const { fetch, calls } = fakeFetch(() => ({
      ip: "8.8.8.8",
      city: "Mountain View",
      region: "California",
      country: "US",
      loc: "37.4056,-122.0775",
      org: "AS15169 Google LLC",
      privacy: { vpn: false, proxy: false, tor: false, hosting: true },
    }));
    const res = await geo.lookupIp({ settings, fetch }, "8.8.8.8");
    expect(calls[0].url).toContain("ipinfo.io/8.8.8.8/json");
    expect(calls[0].url).toContain("token=tok");
    expect(res).not.toBeNull();
    expect(res!.country_code).toBe("US");
    expect(res!.city).toBe("Mountain View");
    expect(res!.region).toBe("California");
    expect(res!.latitude).toBe(37.4056);
    expect(res!.longitude).toBe(-122.0775);
    expect(res!.asn_org).toBe("Google LLC"); // AS number stripped
    expect(res!.is_vpn).toBe(true); // hosting flag
  });

  it("infers VPN from the ASN owner without a privacy dataset; bogons are null", async () => {
    const settings = settingsWith({ IPINFO_API_TOKEN: "tok" });
    const plain = fakeFetch(() => ({ country: "DE", org: "AS24940 Hetzner Online GmbH" }));
    expect((await geo.lookupIpinfo({ settings, fetch: plain.fetch }, "5.9.0.1"))!.is_vpn).toBe(true);
    const bogon = fakeFetch(() => ({ ip: "100.64.0.1", bogon: true }));
    expect(await geo.lookupIpinfo({ settings, fetch: bogon.fetch }, "100.64.0.1")).toBeNull();
    const err = fakeFetch(() => ({}), 429);
    expect(await geo.lookupIpinfo({ settings, fetch: err.fetch }, "1.2.3.4")).toBeNull();
  });

  it("is null without a token", async () => {
    const settings = settingsWith({ IPINFO_API_TOKEN: "" });
    expect(await geo.lookupIpinfo({ settings, fetch: failingFetch }, "8.8.8.8")).toBeNull();
  });

  it("private IPs short-circuit", async () => {
    const settings = settingsWith({ IPINFO_API_TOKEN: "tok" });
    expect(await geo.lookupIp({ settings, fetch: failingFetch }, "127.0.0.1")).toBeNull();
    expect(await geo.lookupIp({ settings, fetch: failingFetch }, "10.0.0.5")).toBeNull();
    expect(await geo.lookupIp({ settings, fetch: failingFetch }, "172.20.1.1")).toBeNull();
    expect(await geo.lookupIp({ settings, fetch: failingFetch }, "")).toBeNull();
  });

  it("the global fetch is used when none is injected", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ country: "FR", city: "Paris" }), { status: 200 }));
    const settings = settingsWith({ IPINFO_API_TOKEN: "tok" });
    const res = await geo.lookupIp({ settings }, "2.2.2.2");
    expect(spy).toHaveBeenCalledOnce();
    expect(res!.city).toBe("Paris");
  });
});

// ---------------------------------------------------------------------------
// test_geoip_maxmind_ws.py (GEO-6..GEO-9)
// ---------------------------------------------------------------------------
const MM = {
  MAXMIND_ACCOUNT_ID: "123456",
  MAXMIND_LICENSE_KEY: "secret_key",
  MAXMIND_WS_HOST: "geoip.maxmind.com",
  MAXMIND_WS_ENDPOINT: "insights",
};

const insightsBody = {
  country: { iso_code: "US", names: { en: "United States" } },
  subdivisions: [{ iso_code: "CA", names: { en: "California" } }],
  city: { names: { en: "Mountain View" } },
  location: { latitude: 37.4056, longitude: -122.0775 },
  traits: {
    isp: "Google LLC",
    autonomous_system_organization: "GOOGLE",
    organization: "Google Cloud",
    is_anonymous_vpn: true,
    is_hosting_provider: true,
    is_anonymous: true,
  },
  maxmind: { queries_remaining: 24881 },
};

const cityBody = {
  country: { iso_code: "US", names: { en: "United States" } },
  subdivisions: [{ names: { en: "Virginia" } }],
  city: { names: { en: "Ashburn" } },
  location: { latitude: 39.0, longitude: -77.5 },
  traits: { isp: "Amazon Technologies", organization: "AWS" },
};

describe("MaxMind GeoIP2 web service", () => {
  it("GEO-6: insights parses geo, ISP and VPN; sends Basic auth with the account id", async () => {
    const settings = settingsWith(MM);
    const { fetch, calls } = fakeFetch(() => insightsBody);
    const res = await geo.lookupMaxmindWs({ settings, fetch }, "8.8.8.8");
    expect(res).toEqual({
      country: "United States",
      country_code: "US",
      region: "California",
      city: "Mountain View",
      latitude: 37.4056,
      longitude: -122.0775,
      is_vpn: true, // anonymizer flag
      asn_org: "Google LLC", // isp wins over org
    });
    expect(calls[0].url).toBe("https://geoip.maxmind.com/geoip/v2.1/insights/8.8.8.8");
    const auth = new Headers(calls[0].init?.headers).get("authorization");
    expect(auth).toBe(`Basic ${btoa("123456:secret_key")}`);
  });

  it("GEO-7: null without credentials", async () => {
    expect(
      await geo.lookupMaxmindWs({ settings: settingsWith({ ...MM, MAXMIND_ACCOUNT_ID: "" }), fetch: failingFetch }, "8.8.8.8"),
    ).toBeNull();
    expect(
      await geo.lookupMaxmindWs({ settings: settingsWith({ ...MM, MAXMIND_LICENSE_KEY: "" }), fetch: failingFetch }, "8.8.8.8"),
    ).toBeNull();
    expect(
      await geo.lookupMaxmindWs({ settings: settingsWith({ ...MM, MAXMIND_ACCOUNT_ID: "abc" }), fetch: failingFetch }, "8.8.8.8"),
    ).toBeNull();
  });

  it("GEO-8: lookupIp prefers MaxMind over IPinfo when there is no request.cf data", async () => {
    const settings = settingsWith({ ...MM, IPINFO_API_TOKEN: "tok" });
    const { fetch, calls } = fakeFetch((url) => {
      if (url.includes("ipinfo.io")) throw new Error("fallback provider should not be called");
      return insightsBody;
    });
    const res = await geo.lookupIp({ settings, fetch }, "8.8.8.8");
    expect(res!.city).toBe("Mountain View");
    expect(res!.is_vpn).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("GEO-9: city endpoint infers VPN from the hosting ASN", async () => {
    const settings = settingsWith({ ...MM, MAXMIND_WS_ENDPOINT: "city" });
    const { fetch, calls } = fakeFetch(() => cityBody);
    const res = await geo.lookupMaxmindWs({ settings, fetch }, "52.1.2.3");
    expect(calls[0].url).toContain("/geoip/v2.1/city/52.1.2.3");
    expect(res!.city).toBe("Ashburn");
    expect(res!.asn_org).toBe("Amazon Technologies");
    expect(res!.is_vpn).toBe(true);
  });

  it("errors fail open and fall through to IPinfo", async () => {
    const settings = settingsWith({ ...MM, IPINFO_API_TOKEN: "tok" });
    const routed = (async (input: RequestInfo | URL) => {
      if (String(input).includes("maxmind")) return new Response('{"code":"AUTHORIZATION_INVALID"}', { status: 401 });
      return new Response(JSON.stringify({ country: "US" }), { status: 200 });
    }) as typeof globalThis.fetch;
    const res = await geo.lookupIp({ settings, fetch: routed }, "8.8.4.4");
    expect(res!.country_code).toBe("US");
  });

  it("private IPs short-circuit", async () => {
    const settings = settingsWith(MM);
    expect(await geo.lookupIp({ settings, fetch: failingFetch }, "127.0.0.1")).toBeNull();
    expect(await geo.lookupIp({ settings, fetch: failingFetch }, "10.0.0.5")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// request.cf (replaces the GeoLite2 .mmdb readers)
// ---------------------------------------------------------------------------
const CF: CfGeo = {
  country: "India",
  countryCode: "IN",
  region: "Karnataka",
  city: "Bengaluru",
  latitude: 12.97,
  longitude: 77.59,
  asn: 24560,
  asOrganization: "Bharti Airtel Ltd.",
};

describe("request.cf geo", () => {
  it("is used without any outbound call when no provider is configured", async () => {
    const settings = settingsWith({});
    const res = await geo.lookupIp({ settings, fetch: failingFetch }, "49.205.201.248", { cf: CF });
    expect(res).toEqual({
      country: "India",
      country_code: "IN",
      region: "Karnataka",
      city: "Bengaluru",
      latitude: 12.97,
      longitude: 77.59,
      is_vpn: false,
      asn_org: "Bharti Airtel Ltd.",
    });
  });

  it("flags hosting/VPN ASNs with the Python keyword heuristic", async () => {
    const settings = settingsWith({ IPINFO_API_TOKEN: "tok" });
    const res = await geo.lookupIp({ settings, fetch: failingFetch }, "45.83.1.1", {
      cf: { ...CF, asOrganization: "M247 Europe SRL" },
    });
    expect(res!.is_vpn).toBe(true);
    expect(geo.isHostingAsn("DigitalOcean, LLC")).toBe(true);
    expect(geo.isHostingAsn("Comcast Cable Communications")).toBe(false);
    expect(geo.isHostingAsn(null)).toBe(false);
  });

  it("MaxMind Insights still decides is_vpn when configured; request.cf fills gaps", async () => {
    const settings = settingsWith(MM);
    const { fetch, calls } = fakeFetch(() => ({
      country: { iso_code: "IN", names: { en: "India" } },
      traits: { isp: "NordVPN", is_anonymous_vpn: true },
      maxmind: { queries_remaining: 100 },
    }));
    const res = await geo.lookupIp({ settings, fetch }, "49.205.201.248", { cf: CF });
    expect(calls).toHaveLength(1);
    expect(res!.is_vpn).toBe(true);
    expect(res!.asn_org).toBe("NordVPN");
    expect(res!.city).toBe("Bengaluru"); // from request.cf
    expect(res!.latitude).toBe(12.97);
  });

  it("MaxMind City endpoint is not called when request.cf already has the ASN", async () => {
    const settings = settingsWith({ ...MM, MAXMIND_WS_ENDPOINT: "city" });
    const res = await geo.lookupIp({ settings, fetch: failingFetch }, "49.205.201.248", { cf: CF });
    expect(res!.city).toBe("Bengaluru");
  });

  it("without an ASN on request.cf, ISP/VPN are topped up from IPinfo", async () => {
    const settings = settingsWith({ IPINFO_API_TOKEN: "tok" });
    const { fetch } = fakeFetch(() => ({ country: "IN", org: "AS9498 Bharti Airtel", privacy: { vpn: true } }));
    const res = await geo.lookupIp({ settings, fetch }, "49.205.201.248", { cf: { ...CF, asOrganization: null, asn: null } });
    expect(res!.city).toBe("Bengaluru");
    expect(res!.country).toBe("India");
    expect(res!.asn_org).toBe("Bharti Airtel");
    expect(res!.is_vpn).toBe(true);
  });

  it("an all-null request.cf (off-edge) falls back to the web services", async () => {
    const empty: CfGeo = {
      country: null, countryCode: null, region: null, city: null,
      latitude: null, longitude: null, asn: null, asOrganization: null,
    };
    expect(geo.geoFromCf(empty)).toBeNull();
    const settings = settingsWith({});
    expect(await geo.lookupIp({ settings, fetch: failingFetch }, "8.8.8.8", { cf: empty })).toBeNull();
  });

  it("isVpnIp blocks on a VPN ASN and fails open on errors", async () => {
    const settings = settingsWith({});
    expect(await isVpnIp({ settings }, "45.83.1.1", { cf: { ...CF, asOrganization: "Mullvad VPN AB" } })).toBe(true);
    expect(await isVpnIp({ settings }, "49.205.201.248", { cf: CF })).toBe(false);
    expect(await isVpnIp({ settings }, null, { cf: CF })).toBe(false);
    const boom = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await isVpnIp({ settings: settingsWith(MM), fetch: boom }, "8.8.8.8")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// test_maxmind_usage.py (service parts)
// ---------------------------------------------------------------------------
describe("MaxMind usage bookkeeping", () => {
  it("record_lookup accumulates and keeps the latest balance", async () => {
    await env.DB.prepare("DELETE FROM maxmind_usage").run();
    await maxmindUsage.recordLookup(db(), { queriesRemaining: 24881, ok: true });
    await maxmindUsage.recordLookup(db(), { queriesRemaining: 24880, ok: true });
    await maxmindUsage.recordLookup(db(), { queriesRemaining: null, ok: false });

    const summary = await maxmindUsage.usageSummary(db(), settingsWith({}));
    expect(summary.lookups_today).toBe(2);
    expect(summary.errors_window).toBe(1);
    // a failed call must not wipe the last known balance
    expect(summary.queries_remaining).toBe(24880);
    expect(summary.lifetime_lookups).toBe(2);
    expect(summary.status).toBe("ok");
  });

  it("burn rate, projection and spend", async () => {
    await env.DB.prepare("DELETE FROM maxmind_usage").run();
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const yesterdayDate = new Date(now.getTime() - 86400_000);
    const yesterday = yesterdayDate.toISOString().slice(0, 10);
    await env.DB.prepare(
      "INSERT INTO maxmind_usage (day, lookups, errors, queries_remaining, updated_at) VALUES (?,100,0,2100,?), (?,300,0,2000,?)",
    )
      .bind(yesterday, yesterdayDate.toISOString(), today, now.toISOString())
      .run();

    const summary = await maxmindUsage.usageSummary(db(), settingsWith({ MAXMIND_UNIT_PRICE_USD: "0.002" }));
    expect(summary.avg_daily).toBe(200.0);
    expect(summary.days_left).toBe(10);
    const expected = new Date(`${today}T00:00:00Z`);
    expected.setUTCDate(expected.getUTCDate() + 10);
    expect(summary.projected_exhaustion).toBe(expected.toISOString().slice(0, 10));
    expect(summary.spend_window_usd).toBeCloseTo(0.8);
    expect(summary.spend_lifetime_usd).toBeCloseTo(0.8);
    expect(summary.daily.map((d) => d.day)).toEqual([yesterday, today]);
  });

  it("thresholds grade the balance", () => {
    const s = settingsWith({ MAXMIND_CREDIT_WARN_THRESHOLD: "5000", MAXMIND_CREDIT_CRIT_THRESHOLD: "1000" });
    expect(maxmindUsage.creditStatus(s, 24881)).toBe("ok");
    expect(maxmindUsage.creditStatus(s, 5000)).toBe("warning");
    expect(maxmindUsage.creditStatus(s, 999)).toBe("critical");
    expect(maxmindUsage.creditStatus(s, null)).toBe("unknown");
  });

  it("a web-service call books usage with MaxMind's own remaining counter", async () => {
    await env.DB.prepare("DELETE FROM maxmind_usage").run();
    const { fetch } = fakeFetch(() => insightsBody);
    await geo.lookupMaxmindWs({ settings: settingsWith(MM), fetch, db: db() }, "8.8.8.8");
    const failing = (async () => new Response("{}", { status: 500 })) as unknown as typeof globalThis.fetch;
    await geo.lookupMaxmindWs({ settings: settingsWith(MM), fetch: failing, db: db() }, "8.8.8.8");
    const row = await env.DB.prepare("SELECT lookups, errors, queries_remaining FROM maxmind_usage").first();
    expect(row).toEqual({ lookups: 1, errors: 1, queries_remaining: 24881 });
  });

  it("usage bookkeeping never breaks geo", async () => {
    const broken = { run: () => Promise.reject(new Error("ledger down")) } as unknown as ReturnType<typeof getDb>;
    await expect(geo.recordWsUsage({ settings: settingsWith(MM), db: broken }, 123, true)).resolves.toBeUndefined();
    await expect(maxmindUsage.recordLookup(broken, { queriesRemaining: 1, ok: true })).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// test_company_intent.py (resolver / IPinfo adapter half)
// ---------------------------------------------------------------------------
describe("company intel resolver", () => {
  it("is null when disabled or on the asn provider", async () => {
    expect(await resolveCompany({ settings: settingsWith({ COMPANY_INTEL_PROVIDER: "none" }), fetch: failingFetch }, "8.8.8.8")).toBeNull();
    expect(await resolveCompany({ settings: settingsWith({ COMPANY_INTEL_PROVIDER: "asn" }), fetch: failingFetch }, "8.8.8.8")).toBeNull();
  });

  it("IPinfo adapter parses the company object and ignores a bare org", async () => {
    const payloads: Record<string, unknown> = {
      "1.1.1.1": { ip: "1.1.1.1", company: { name: "Stripe", domain: "stripe.com", type: "business" } },
      "2.2.2.2": { ip: "2.2.2.2", org: "AS7922 Comcast Cable" },
    };
    const { fetch } = fakeFetch((url) => payloads[new URL(url).pathname.split("/")[1]] ?? {});
    const settings = settingsWith({ COMPANY_INTEL_PROVIDER: "ipinfo", IPINFO_API_TOKEN: "tok" });
    expect(await resolveCompany({ settings, fetch }, "1.1.1.1")).toEqual({
      name: "Stripe",
      domain: "stripe.com",
      industry: null,
      size: null,
      type: "business",
    });
    expect(await resolveCompany({ settings, fetch }, "2.2.2.2")).toBeNull();
    const noToken = settingsWith({ COMPANY_INTEL_PROVIDER: "ipinfo", IPINFO_API_TOKEN: "" });
    expect(await resolveCompany({ settings: noToken, fetch: failingFetch }, "1.1.1.1")).toBeNull();
  });
});
