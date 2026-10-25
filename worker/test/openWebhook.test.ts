/**
 * Contact-bound links + the signed "link opened" webhook (voice follow-up loop).
 */
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { getDb } from "../src/db/client";
import { buildSettings, type Env } from "../src/env";
import { bytesToHex, hmacSha256 } from "../src/lib/crypto";
import * as utm from "../src/services/utm";
import { api, createUser } from "./helpers";

const db = () => getDb(env.DB);
const settingsWith = (vars: Record<string, string>) => buildSettings({ ...(env as unknown as Env), ...vars });
const HOOK = { OPEN_WEBHOOK_URL: "https://hook.example.com/beam", OPEN_WEBHOOK_SECRET: "whsec-test" };
const svc = { "X-Service-Key": "svc-test-key" };

function recorder() {
  const calls: { url: string; headers: Headers; body: string }[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers), body: String(init?.body) });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  return { fetch: f, calls };
}

async function link(contactRef: string | null) {
  const u = await createUser();
  return utm.recordLink(db(), {
    userId: u.id,
    originalUrl: "https://example.com/brochure",
    trackedUrl: "https://example.com/brochure?utm_source=voice",
    utmParams: { utm_source: "voice" },
    contactRef,
  });
}

async function open(l: { id: string }, ua: string, extra: Record<string, string> = {}) {
  const rec = recorder();
  const id = await utm.insertClickEvent(db(), { linkId: l.id, ipAddress: "203.0.113.9", userAgent: ua, referrer: null });
  await utm.resolveGeoForEvent({ settings: settingsWith({ ...HOOK, ...extra }), db: db(), fetch: rec.fetch }, id, "203.0.113.9", {
    cf: { country: "India", countryCode: "IN", region: "Karnataka", city: "Bengaluru", asOrganization: "Acme Broadband" } as never,
  });
  return rec.calls;
}

const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36";

describe("contact-bound links", () => {
  // The service key resolves to a pre-provisioned user; production needs service+<name>@championsmail.com too.
  beforeAll(() => createUser({ email: "service+champ-workspace@championsmail.com" }));

  it("mints per-contact links through the service-key lane and never merges contacts", async () => {
    const mint = async (ref?: string) =>
      (await api("/api/v1/utm/generate", { method: "POST", headers: svc, json: { url: "https://example.com/x", utm_source: "voice", ...(ref ? { contact_ref: ref } : {}) } })).json() as Promise<{ link_id: string }>;
    const a1 = await mint("drop_a");
    const a2 = await mint("drop_a");
    const b = await mint("drop_b");
    const anon = await mint();
    expect(a1.link_id).toBe(a2.link_id);
    expect(new Set([a1.link_id, b.link_id, anon.link_id]).size).toBe(3);
    const row = await env.DB.prepare("SELECT contact_ref FROM link_clicks WHERE id = ?").bind(a1.link_id).first();
    expect(row).toEqual({ contact_ref: "drop_a" });
  });

  it("rejects an empty contact_ref", async () => {
    const r = await api("/api/v1/utm/generate", { method: "POST", headers: svc, json: { url: "https://example.com/x", contact_ref: "" } });
    expect(r.status).toBe(422);
  });
});

describe("link.opened webhook", () => {
  it("posts a signed payload with contact, ip, geo and network for a real browser", async () => {
    const l = await link("drop_a");
    const calls = await open(l, CHROME);
    expect(calls).toHaveLength(1);
    const [c] = calls;
    expect(c.url).toBe(HOOK.OPEN_WEBHOOK_URL);
    const expected = bytesToHex(await hmacSha256(HOOK.OPEN_WEBHOOK_SECRET, c.body));
    expect(c.headers.get("x-beam-signature")).toBe(`sha256=${expected}`);
    const p = JSON.parse(c.body);
    expect(p).toMatchObject({
      event: "link.opened",
      contact_ref: "drop_a",
      ip: "203.0.113.9",
      geo: { country_code: "IN", city: "Bengaluru" },
      network: { asn_org: "Acme Broadband" },
      likely_scanner: false,
    });
    expect(c.headers.get("x-beam-event-id")).toBe(p.event_id);
  });

  it("flags a datacenter-ASN click as a likely scanner instead of dropping it", async () => {
    const l = await link("drop_a");
    const rec = recorder();
    const id = await utm.insertClickEvent(db(), { linkId: l.id, ipAddress: "198.51.100.7", userAgent: CHROME, referrer: null });
    await utm.resolveGeoForEvent({ settings: settingsWith(HOOK), db: db(), fetch: rec.fetch }, id, "198.51.100.7", {
      cf: { country: "United States", countryCode: "US", asOrganization: "Amazon.com, Inc. hosting" } as never,
    });
    expect(JSON.parse(rec.calls[0].body).likely_scanner).toBe(true);
  });

  it("stays silent for bots, anonymous links and unconfigured deployments", async () => {
    expect(await open(await link("drop_a"), "WhatsApp/2.23.20 A")).toHaveLength(0);
    expect(await open(await link("drop_a"), "Googlebot/2.1 (+http://www.google.com/bot.html)")).toHaveLength(0);
    expect(await open(await link(null), CHROME)).toHaveLength(0);
    expect(await open(await link("drop_a"), CHROME, { OPEN_WEBHOOK_URL: "" })).toHaveLength(0);
  });
});
