/**
 * Public redirect path (/r, /s). Ports backend/tests/test_click_tracking.py
 * (route case) and the link cases of test_access_controls.py; owner-side
 * checks (leads/access endpoints) read D1 directly instead of the utm router.
 */
import { describe, expect, it, vi } from "vitest";
import { api, env } from "./helpers";
import { code, form, iso, Jar, newUser, row, rows, seedDomain, seedLink, setSettings } from "./serveSeed";

describe("click tracking (test_click_tracking.py)", () => {
  it("counts unique clicks by distinct IP", async () => {
    const uid = await newUser();
    const sc = code("u");
    const lid = await seedLink(uid, sc);
    // Same IP twice, then a different IP once -> 3 clicks, 2 unique.
    for (const ip of ["10.0.0.1", "10.0.0.1", "10.0.0.2"]) {
      const r = await api(`/r/${sc}`, { headers: { "X-Forwarded-For": ip } });
      expect(r.status).toBe(302);
      expect(r.headers.get("location")).toBe("https://example.com/dest");
    }
    const link = await row("SELECT click_count, unique_clicks FROM link_clicks WHERE id = ?", lid);
    expect(link).toMatchObject({ click_count: 3, unique_clicks: 2 });
    const evs = await rows("SELECT ip_address, link_id FROM click_events WHERE link_id = ?", lid);
    expect(evs.map((e) => e.ip_address).sort()).toEqual(["10.0.0.1", "10.0.0.1", "10.0.0.2"]);
  });

  it("/s is a full alias of /r (gates + events)", async () => {
    const uid = await newUser();
    const sc = code("s");
    const lid = await seedLink(uid, sc);
    const r = await api(`/s/${sc}`, { headers: { "CF-Connecting-IP": "10.1.1.1" } });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("https://example.com/dest");
    expect((await row("SELECT click_count FROM link_clicks WHERE id = ?", lid))!.click_count).toBe(1);
    expect((await rows("SELECT id FROM click_events WHERE link_id = ?", lid)).length).toBe(1);

    const gated = code("s");
    await seedLink(uid, gated, { require_email: true });
    const g = await api(`/s/${gated}`);
    expect(g.status).toBe(200);
    expect(await g.text()).toContain(`action="/r/${gated}/unlock"`);
  });

  it("unknown code and unknown custom host redirect to /", async () => {
    const r = await api("/r/nope-nope");
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/");

    const uid = await newUser();
    const sc = code("h");
    await seedLink(uid, sc);
    const other = await api(`https://nobody.example.org/r/${sc}`);
    expect(other.status).toBe(302);
    expect(other.headers.get("location")).toBe("/");
  });

  it("custom domain looks up its own namespace", async () => {
    const uid = await newUser();
    const host = `go-${crypto.randomUUID().slice(0, 6)}.example.net`;
    const did = await seedDomain(uid, host);
    const sc = code("d");
    await seedLink(uid, sc, { domain_id: did, tracked_url: "https://example.com/custom" });
    const r = await api(`https://${host}/r/${sc}`);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("https://example.com/custom");
    // Not visible on the platform host.
    expect((await api(`/r/${sc}`)).headers.get("location")).toBe("/");
    const ev = await row("SELECT domain_id FROM click_events WHERE link_id = (SELECT id FROM link_clicks WHERE short_code = ?)", sc);
    expect(ev!.domain_id).toBe(did);
  });

  it("quotes the Location like Starlette's RedirectResponse", async () => {
    const uid = await newUser();
    const sc = code("q");
    await seedLink(uid, sc, { tracked_url: "https://example.com/a b?x=é" });
    const r = await api(`/r/${sc}`);
    expect(r.headers.get("location")).toBe("https://example.com/a%20b?x=%C3%A9");
  });
});

describe("link access controls (test_access_controls.py)", () => {
  it("view cap self-destructs", async () => {
    const uid = await newUser();
    const sc = code("cap");
    const lid = await seedLink(uid, sc, { max_views: 2 });
    const r1 = await api(`/r/${sc}`, { headers: { "X-Forwarded-For": "1.1.1.1" } });
    const r2 = await api(`/r/${sc}`, { headers: { "X-Forwarded-For": "1.1.1.2" } });
    const r3 = await api(`/r/${sc}`, { headers: { "X-Forwarded-For": "1.1.1.3" } });
    expect([r1.status, r2.status]).toEqual([302, 302]);
    expect(r3.status).toBe(410); // burned after 2 views
    expect(await r3.text()).toContain("View limit reached");
    expect((await row("SELECT click_count FROM link_clicks WHERE id = ?", lid))!.click_count).toBe(2);
  });

  it("expiry and revoke block", async () => {
    const uid = await newUser();
    const exp = code("exp");
    const rev = code("rev");
    await seedLink(uid, exp, { expires_at: iso(-3600_000) });
    await seedLink(uid, rev, { revoked_at: iso() });
    const e = await api(`/r/${exp}`);
    expect(e.status).toBe(410);
    expect(await e.text()).toContain("Link expired");
    const r = await api(`/r/${rev}`);
    expect(r.status).toBe(410);
    expect(await r.text()).toContain("Link revoked");
  });

  it("email gate captures the lead, then grants", async () => {
    const uid = await newUser();
    const sc = code("gate");
    const lid = await seedLink(uid, sc, { require_email: true });
    const jar = new Jar();

    // No cookie -> gate page (200 HTML), not a redirect.
    const g = await jar.fetch(`/r/${sc}`);
    expect(g.status).toBe(200);
    expect(await g.text()).toContain("Enter your email");

    // Bad email -> gate page with error, no lead.
    const bad = await jar.fetch(`/r/${sc}/unlock`, form({ email: "nope" }));
    expect(bad.status).toBe(200);
    expect(await bad.text()).toContain("Please enter a valid email.");

    // Good email -> 303 + cookie set + lead captured.
    const ok = await jar.fetch(`/r/${sc}/unlock`, { ...form({ email: "buyer@corp.com" }), headers: { ...form({}).headers, "X-Forwarded-For": "9.9.9.9" } });
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe(`/r/${sc}`);
    const sc_ = ok.headers.get("set-cookie") ?? "";
    expect(sc_).toContain("cbgate_");
    expect(sc_).toBe(`cbgate_${sc}=1; HttpOnly; Max-Age=2592000; Path=/; SameSite=lax`);

    // The cookie is now in the jar -> access granted.
    expect((await jar.fetch(`/r/${sc}`)).status).toBe(302);

    const leads = await rows("SELECT email, ip_address FROM access_leads WHERE link_id = ?", lid);
    expect(leads).toEqual([{ email: "buyer@corp.com", ip_address: "9.9.9.9" }]);
  });

  it("blocks VPN visitors (block_vpn)", async () => {
    const uid = await newUser();
    const sc = code("vpn");
    await seedLink(uid, sc, { block_vpn: true });
    setSettings({ ipinfoApiToken: "tok" });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      const vpn = url.includes("/6.6.6.6/");
      return new Response(JSON.stringify({ country: "US", org: "AS1 Example", privacy: { vpn } }), {
        headers: { "content-type": "application/json" },
      });
    });
    const blocked = await api(`/r/${sc}`, { headers: { "X-Forwarded-For": "6.6.6.6" } });
    expect(blocked.status).toBe(410);
    expect(await blocked.text()).toContain("Access blocked");
    const ok = await api(`/r/${sc}`, { headers: { "X-Forwarded-For": "1.2.3.4" } });
    expect(ok.status).toBe(302);
  });

  it("branded gate pages carry the custom domain", async () => {
    const uid = await newUser();
    const host = `br-${crypto.randomUUID().slice(0, 6)}.example.net`;
    const did = await seedDomain(uid, host);
    const sc = code("br");
    await seedLink(uid, sc, { domain_id: did, branded: true, revoked_at: iso() });
    const r = await api(`https://${host}/r/${sc}`);
    expect(r.status).toBe(410);
    expect(await r.text()).toContain(`<div class="brand">${host}</div>`);
  });

  it("re-mints ChampVault delivery URLs and never redirects to champvault://", async () => {
    const uid = await newUser();
    const fresh = code("cv");
    await seedLink(uid, fresh, {
      champvault_asset_id: "asset-1",
      original_url: "champvault://asset-1",
      tracked_url: "https://old.example.com/stale",
    });
    setSettings({ champvaultUrl: "https://vault.example.com", champvaultApiKey: "k", champvaultConfigured: true });
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ kind: "video", iframeUrl: "https://stream.example.com/x", hlsUrl: "h" }), {
        headers: { "content-type": "application/json" },
      }),
    );
    const r = await api(`/r/${fresh}`);
    expect(r.headers.get("location")).toBe("https://stream.example.com/x");
    expect(String(spy.mock.calls[0][0])).toBe("https://vault.example.com/api/v1/assets/asset-1/deliver");

    // ChampVault down -> last-known URL; pseudo URL only -> "/".
    spy.mockImplementation(async () => new Response("down", { status: 500 }));
    expect((await api(`/r/${fresh}`)).headers.get("location")).toBe("https://old.example.com/stale");
    const pseudo = code("cv");
    await seedLink(uid, pseudo, { champvault_asset_id: "asset-2", original_url: "champvault://asset-2", tracked_url: null });
    expect((await api(`/r/${pseudo}`)).headers.get("location")).toBe("/");
  });
});

void env;
