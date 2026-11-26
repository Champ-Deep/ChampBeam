/**
 * A1 forward alerts: the detectForwards rule table, the cron scan on seeded D1, and the /alerts API
 * (owner-only 404s, mock draft saved, the privacy gate on stubbed replies, 503 with no upstream call).
 * No real network: every upstream call is a vi.spyOn(fetch) stub. Each test seeds its own rows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSettings, type Env } from "../src/env";
import { detectForwards, ownerDomainOf, scanForwards } from "../src/services/forwardAlerts";
import { api, apiKeyHeaders, createApiKey, createUser, env, json, orgSession, sessionHeaders } from "./helpers";
import { restoreSettings, setSettings } from "./orgTestUtils";
import { code, seedLink, seedPage } from "./serveSeed";

// ---- detectForwards (pure) ----------------------------------------------------------------------

let seq = 0;
const T0 = Date.now() - 2 * 86_400_000;
const ev = (o: Record<string, unknown> = {}) => ({
  id: `e${++seq}`, visitor_id: "v1", city: "Mumbai", country_code: "IN", is_vpn: 0, asn_org: null, device_type: "desktop",
  company_name: null, company_domain: null, company_type: null, clicked_at: new Date(T0 + seq * 60_000).toISOString(), ...o,
});
const PUNE = { city: "Pune", country_code: "IN" };
const co = (domain: string, visitor = domain) => ({ company_domain: domain, company_name: `${domain} Corp`, company_type: "business", visitor_id: visitor });
const keys = (xs: { dedupe_key: string }[]) => xs.map((x) => x.dedupe_key);

describe("detectForwards", () => {
  it("1 visitor in 2 cities is no alert", () => {
    expect(detectForwards([ev(), ev(PUNE)], null)).toEqual([]);
  });

  it("2 visitors in 1 city is no alert", () => {
    expect(detectForwards([ev(), ev({ visitor_id: "v2" })], null)).toEqual([]);
  });

  it("2 visitors in 2 cities is one cities alert, evidence = the event that made both true", () => {
    const second = ev({ ...PUNE, visitor_id: "v2" });
    const out = detectForwards([ev(), second, ev({ city: "Delhi", visitor_id: "v3" })], null);
    expect(out).toEqual([
      { reason: "cities", dedupe_key: "cities", cities: ["Mumbai, IN", "Pune, IN"], visitor_ids: ["v1", "v2"], company_name: null, company_domain: null, evidence_event_id: second.id },
    ]);
  });

  it("ignores bot, VPN, hosting-ASN and visitorless rows", () => {
    const noise = [
      ev({ ...PUNE, device_type: "bot", ...co("b.com", "bot") }),
      ev({ ...PUNE, is_vpn: 1, ...co("c.com", "vpn") }),
      ev({ ...PUNE, asn_org: "Amazon.com, Inc. AWS", ...co("d.com", "aws") }),
      ev({ ...PUNE, ...co("e.com", "") }),
    ];
    expect(detectForwards([ev(co("a.com", "v1")), ...noise], null)).toEqual([]);
  });

  it("ignores the owner's own company domain and isp/hosting/vpn company types", () => {
    const owner = ownerDomainOf("deep@lakeb2b.com");
    expect(owner).toBe("lakeb2b.com");
    const events = [ev(co("lakeb2b.com", "v1")), ev(co("acme.com", "v1")), ev({ ...co("jio.com", "v1"), company_type: "ISP" })];
    expect(detectForwards(events, owner)).toEqual([]);
  });

  it("a gmail owner excludes no company", () => {
    for (const free of ["gmail.com", "outlook.com", "hotmail.com", "yahoo.com", "icloud.com", "proton.me"]) expect(ownerDomainOf(`x@${free}`)).toBeNull();
    const out = detectForwards([ev(co("acme.com")), ev(co("beta.com"))], ownerDomainOf("deep@gmail.com"));
    expect(out).toMatchObject([{ reason: "new_company", dedupe_key: "company:beta.com", company_name: "beta.com Corp", company_domain: "beta.com", visitor_ids: ["beta.com"] }]);
  });

  it("2nd company fires once, 3rd company fires once more", () => {
    const events = [ev(co("acme.com")), ev(co("beta.com")), ev(co("beta.com", "v9")), ev(co("gamma.com"))];
    expect(keys(detectForwards(events, null))).toEqual(["company:beta.com", "company:gamma.com"]);
  });

  it("drops the 6th candidate on one asset", () => {
    const events = [ev({ visitor_id: "v1" }), ev({ ...PUNE, visitor_id: "v2" }), ...["a", "b", "c", "d", "e", "f"].map((x) => ev(co(`${x}.com`)))];
    expect(keys(detectForwards(events, null))).toEqual(["cities", "company:b.com", "company:c.com", "company:d.com", "company:e.com"]);
  });
});

// ---- scanForwards (seeded D1) -------------------------------------------------------------------

async function click(linkId: string, o: Record<string, unknown>) {
  const row: Record<string, unknown> = {
    id: crypto.randomUUID(), link_id: linkId, visitor_id: "v1", is_revisit: 0, is_vpn: 0, device_type: "desktop",
    clicked_at: new Date(Date.now() - 5 * 60_000).toISOString(), ...o,
  };
  const cols = Object.keys(row);
  await env.DB.prepare(`INSERT INTO click_events (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).bind(...cols.map((k) => row[k])).run();
}
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const alertsFor = async (assetId: string) =>
  (await env.DB.prepare("SELECT * FROM forward_alerts WHERE asset_id = ? ORDER BY dedupe_key").bind(assetId).all<Record<string, any>>()).results;

describe("scanForwards", () => {
  it("inserts once, a second run inserts nothing", async () => {
    const owner = await createUser({ email: "owner@lakeb2b.com" });
    const link = await seedLink(owner.id, code());
    await click(link, { city: "Mumbai", country_code: "IN", company_domain: "acme.com", company_name: "Acme", company_type: "business", clicked_at: ago(9) });
    await click(link, { city: "Pune", country_code: "IN", visitor_id: "v2", company_domain: "beta.com", company_name: "Beta", company_type: "business", clicked_at: ago(8) });
    await click(link, { city: "Delhi", visitor_id: "v3", company_domain: "lakeb2b.com", company_type: "business", clicked_at: ago(7) });
    expect(await scanForwards(env as unknown as Env)).toBeGreaterThanOrEqual(2);
    const first = await alertsFor(link);
    expect(first.map((a) => [a.reason, a.dedupe_key, a.user_id])).toEqual([
      ["cities", "cities", owner.id],
      ["new_company", "company:beta.com", owner.id],
    ]);
    expect(JSON.parse(first[0].cities)).toEqual(["Mumbai, IN", "Pune, IN"]);
    for (const col of ["ip_address", "user_agent", "email"]) expect(Object.keys(first[0])).not.toContain(col);

    await scanForwards(env as unknown as Env);
    expect((await alertsFor(link)).map((a) => a.id)).toEqual(first.map((a) => a.id));
  });

  it("stops at 5 alerts per asset ever", async () => {
    const owner = await createUser();
    const link = await seedLink(owner.id, code());
    for (const k of ["k1", "k2", "k3", "k4", "k5"]) {
      await env.DB.prepare("INSERT INTO forward_alerts (id, user_id, asset_type, asset_id, reason, dedupe_key, detected_at) VALUES (?,?,?,?,?,?,?)")
        .bind(crypto.randomUUID(), owner.id, "link", link, "new_company", k, new Date().toISOString()).run();
    }
    await click(link, { city: "Mumbai", country_code: "IN" });
    await click(link, { city: "Pune", country_code: "IN", visitor_id: "v2" });
    await scanForwards(env as unknown as Env);
    expect((await alertsFor(link)).length).toBe(5);
  });
});

// ---- /api/v1/alerts ------------------------------------------------------------------------------

const MOCK = {
  subject: "[mock] Quick follow-up",
  body: "Hi {first_name},\n\n[mock] Happy to walk you and anyone on your team through this. Would 15 minutes this week help?",
};
const put = (headers: HeadersInit, body: object) => api("/api/v1/assistant/config", { method: "PUT", headers, json: body });
const post = (path: string, headers: HeadersInit) => api(`/api/v1/alerts/forwards${path}`, { method: "POST", headers });

let admin: Awaited<ReturnType<typeof orgSession>>;
beforeEach(async () => {
  admin = await orgSession({ role: "admin" });
  expect((await put(admin.headers, { provider: "mock", model: "test/model", enabled: true, job_models: { forward_followup: null } })).status).toBe(200);
});
afterEach(() => {
  restoreSettings();
  vi.restoreAllMocks();
});

/** An owner with a session, one link and one cities alert on it (Mumbai and Pune, visitors v1 and v2). */
async function seeded() {
  const owner = await createUser();
  const headers = await sessionHeaders(owner.id);
  const link = await seedLink(owner.id, code(), { anchor_text: "Acme deck" });
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO forward_alerts (id, user_id, asset_type, asset_id, reason, dedupe_key, cities, visitor_ids, detected_at) VALUES (?,?,?,?,?,?,?,?,?)",
  )
    .bind(id, owner.id, "link", link, "cities", "cities", '["Mumbai, IN","Pune, IN"]', '["v1","v2"]', new Date().toISOString())
    .run();
  return { owner, headers, link, id };
}
const alertRow = (id: string) => env.DB.prepare("SELECT * FROM forward_alerts WHERE id = ?").bind(id).first<Record<string, any>>();
const openrouter = async () => expect((await put(admin.headers, { provider: "openrouter", model: "meta/test:free" })).status).toBe(200);
/** OpenRouter answers `draft`; returns the spy so a test can read the request it got. */
const upstream = (draft: object) =>
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (String(input).startsWith("https://openrouter.ai/")) {
      return Response.json({ choices: [{ message: { content: JSON.stringify(draft) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    }
    throw new Error(`unexpected fetch ${String(input)}`);
  });

describe("alerts API", () => {
  it("lists the owner's alerts with unread, marks seen and dismisses idempotently", async () => {
    const { headers, link, id } = await seeded();
    let body = await json(await api("/api/v1/alerts/forwards", { headers }));
    expect(body.unread).toBe(1);
    expect(body.alerts).toHaveLength(1);
    expect(body.alerts[0]).toMatchObject({
      id, reason: "cities", cities: ["Mumbai, IN", "Pune, IN"], visitors: 2, company_name: null, seen_at: null, dismissed_at: null, draft: null,
      asset: { type: "link", id: link, title: "Acme deck" }, sender_notes: ["Opened by 2 visitors in Mumbai, IN and Pune, IN"],
    });
    expect(body.alerts[0].asset.url).toMatch(/\/r\/c/);
    expect(JSON.stringify(body)).not.toContain("visitor_ids");

    for (let i = 0; i < 2; i++) expect((await post(`/${id}/seen`, headers)).status).toBe(204);
    const seenAt = (await alertRow(id))!.seen_at;
    expect(seenAt).toBeTruthy();
    expect((await post(`/${id}/seen`, headers)).status).toBe(204);
    expect((await alertRow(id))!.seen_at).toBe(seenAt);
    expect((await json(await api("/api/v1/alerts/forwards", { headers }))).unread).toBe(0);

    for (let i = 0; i < 2; i++) expect((await post(`/${id}/dismiss`, headers)).status).toBe(204);
    expect((await json(await api("/api/v1/alerts/forwards", { headers }))).alerts).toEqual([]);
    body = await json(await api("/api/v1/alerts/forwards?status=all", { headers }));
    expect(body.alerts[0].dismissed_at).toBeTruthy();
    expect((await api("/api/v1/alerts/forwards?limit=101", { headers })).status).toBe(422);
  });

  it("another user's alert id answers 404 on all four routes", async () => {
    const { id } = await seeded();
    const stranger = await sessionHeaders((await createUser()).id);
    expect((await json(await api("/api/v1/alerts/forwards?status=all", { headers: stranger }))).alerts).toEqual([]);
    for (const path of ["seen", "dismiss", "draft"]) expect((await post(`/${id}/${path}`, stranger)).status).toBe(404);
    const row = (await alertRow(id))!;
    expect([row.seen_at, row.dismissed_at, row.draft_body]).toEqual([null, null, null]);
  });

  it("draft on the mock provider returns the fixture and saves it", async () => {
    const { owner, headers, id } = await seeded();
    const res = await post(`/${id}/draft`, headers);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.draft).toMatchObject({ ...MOCK, model: "test/model" });
    expect(body.sender_notes).toEqual(["Opened by 2 visitors in Mumbai, IN and Pune, IN"]);
    const row = (await alertRow(id))!;
    expect([row.draft_subject, row.draft_body, row.draft_model, row.draft_created_at]).toEqual([MOCK.subject, MOCK.body, "test/model", body.draft.created_at]);
    expect((await json(await api("/api/v1/alerts/forwards", { headers }))).alerts[0].draft).toEqual(body.draft);
    const key = apiKeyHeaders(await createApiKey(owner.id));
    expect((await post(`/${id}/draft`, key)).status).toBe(403);
    expect((await api("/api/v1/alerts/forwards", { headers: key })).status).toBe(200);
  });

  it("sends the model the topics, never dwell, cities or visitor counts", async () => {
    const { owner, headers, id } = await seeded();
    const page = await seedPage(owner.id, "<html><body><h1>Pricing tiers</h1><script>secretFn()</script><p>Starter and Team plans.</p></body></html>", { filename: "Acme-pricing.html" });
    await env.DB.prepare("INSERT INTO page_engagements (id, file_id, session_id, visitor_id, page, dwell_ms, created_at) VALUES (?,?,?,?,?,?,?)")
      .bind(crypto.randomUUID(), page.id, "s1", "v2", 0, 130_000, new Date().toISOString()).run();
    await openrouter();
    const ok = { subject: "Quick follow-up", body: "Hi {first_name},\n\nHappy to walk you and your colleagues through the plans. Would 15 minutes on Thursday work?" };
    const spy = upstream(ok);
    const res = await post(`/${id}/draft`, headers);
    expect(res.status).toBe(200);
    expect((await json(res)).sender_notes).toEqual(["Opened by 2 visitors in Mumbai, IN and Pune, IN", '2m 10s on "Acme pricing" (page)']);
    const sent = String((spy.mock.calls[0][1] as RequestInit).body);
    expect(sent).toContain("Pricing tiers Starter and Team plans.");
    expect(sent).toContain('\\"Acme deck\\"');
    for (const leak of ["Mumbai", "Pune", "130000", "2m 10s", "secretFn", "2 visitors"]) expect(sent).not.toContain(leak);
  });

  it("a reply saying 'I noticed you viewed' answers 502 and leaves the row unchanged", async () => {
    const { headers, id } = await seeded();
    await openrouter();
    upstream({ subject: "Following up", body: "Hi {first_name},\n\nI noticed you viewed the deck yesterday. Shall we talk this week?" });
    const before = await alertRow(id);
    const res = await post(`/${id}/draft`, headers);
    expect([res.status, (await json(res)).detail]).toEqual([502, "The draft broke a privacy rule. Try again."]);
    expect(await alertRow(id)).toEqual(before);
  });

  it("a reply naming the alert's city answers 502 and leaves the row unchanged", async () => {
    const { headers, id } = await seeded();
    await openrouter();
    upstream({ subject: "Following up", body: "Hi {first_name},\n\nHappy to meet your team in Pune and walk everyone through it. Does Friday suit?" });
    const before = await alertRow(id);
    const res = await post(`/${id}/draft`, headers);
    expect([res.status, (await json(res)).detail]).toEqual([502, "The draft broke a privacy rule. Try again."]);
    expect(await alertRow(id)).toEqual(before);
  });

  it("answers 503 for openrouter with no key and never calls fetch", async () => {
    const { headers, id } = await seeded();
    await openrouter();
    setSettings({ assistantOpenrouterApiKey: "" });
    expect(getSettings(env as unknown as Env).assistantOpenrouterApiKey).toBe("");
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("no fetch expected");
    });
    const res = await post(`/${id}/draft`, headers);
    expect([res.status, (await json(res)).detail]).toEqual([503, "The openrouter provider has no API key configured."]);
    expect(spy).not.toHaveBeenCalled();
    expect((await alertRow(id))!.draft_body).toBeNull();
  });
});
