/**
 * Beam Pages serving (/p, /f for html) and the access-code gate. Ports the
 * serving parts of backend/tests/test_beam_pages.py and all of
 * test_access_code.py, with pages published by seeding D1 + R2 directly
 * (the /api/v1/pages owner router is tested in its own file). Owner actions
 * (PATCH enabled / access_code, DELETE) are applied as the row changes they make.
 */
import { describe, expect, it } from "vitest";
import { api, env } from "./helpers";
import { hashAccessCode } from "../src/lib/accessControl";
import { trackingSnippet } from "../src/services/pages";
import { form, iso, Jar, newUser, row, rows, seedDomain, seedPage, settings } from "./serveSeed";

const HTML =
  "<!doctype html><html><head><title>T</title></head><body><p>hello</p><script>localStorage.x=1</script></body></html>";

describe("publish + serve (test_beam_pages.py)", () => {
  it("serves on slug and legacy code with the snippet injected", async () => {
    const uid = await newUser();
    const page = await seedPage(uid, HTML, { slug: "pallab-north-star" });

    const r = await api("/p/pallab-north-star");
    expect(r.status).toBe(200);
    expect(r.headers.get("set-cookie")).toContain("cb_vid=");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(r.headers.get("content-type")).toBe("text/html");
    expect(r.headers.get("content-disposition")).toBe('inline; filename="index.html"');
    const body = new Uint8Array(await r.arrayBuffer());
    const text = new TextDecoder().decode(body);
    expect(text).toContain("<script>(function(){var C=");
    expect(text).toContain("localStorage.x=1"); // original inline JS preserved
    expect(text.indexOf("<script>(function(){var C=")).toBe(text.indexOf("<head>") + "<head>".length);
    expect(r.headers.get("content-length")).toBe(String(body.length));
    expect(text).toContain(`"u":"/f/${page.shortCode}/page-events"`);

    const legacy = await api(`/f/${page.shortCode}`);
    expect(legacy.status).toBe(200);
    expect(await legacy.text()).toContain("<script>(function(){var C=");

    // The stored blob is never modified.
    expect(await (await env.FILES.get(page.storageKey))!.text()).toBe(HTML);
    // Uppercase / padded slug normalizes.
    expect((await api("/p/PALLAB-NORTH-STAR")).status).toBe(200);
  });

  it("mints the Beam State token and exposes window.__BEAM__", async () => {
    const uid = await newUser();
    const page = await seedPage(uid, HTML);
    const r = await api(`/p/${page.slug}`);
    const m = /window\.__BEAM__=\{page:"([^"]+)",token:"([^"]+)"/.exec(await r.text());
    expect(m).not.toBeNull();
    expect(m![1]).toBe(page.slug);
    const stored = await row("SELECT state_token FROM file_assets WHERE id = ?", page.id);
    expect(stored!.state_token).toBe(m![2]);
    // Stable across views.
    const again = /token:"([^"]+)"/.exec(await (await api(`/p/${page.slug}`)).text());
    expect(again![1]).toBe(m![2]);
  });

  it("non-html assets are not reachable on /p", async () => {
    const uid = await newUser();
    const page = await seedPage(uid, HTML, { kind: "pdf", mime: "application/pdf" });
    const r = await api(`/p/${page.slug}`);
    expect(r.status).toBe(404);
    expect(await r.text()).toBe("Page not found.");
  });

  it("pages over the injection cap stream untouched", async () => {
    const uid = await newUser();
    const page = await seedPage(uid, HTML);
    const { pagesInjectMaxBytes } = settings();
    settings().pagesInjectMaxBytes = 10;
    try {
      const r = await api(`/p/${page.slug}`);
      expect(await r.text()).toBe(HTML);
      expect(r.headers.get("cache-control")).toBe("private, max-age=300");
    } finally {
      settings().pagesInjectMaxBytes = pagesInjectMaxBytes;
    }
  });

  it("snippet escapes a script close in the visitor id", () => {
    const s = trackingSnippet({ visitorId: "v</script><b>", pageId: "p", beaconUrl: "/f/x/page-events" });
    expect(s.split("</script>")[0]).not.toContain("</script><b>");
  });
});

describe("slug moves, kill switch, delete (test_beam_pages.py)", () => {
  it("slug change: /p follows the new slug", async () => {
    const uid = await newUser();
    const page = await seedPage(uid, HTML, { slug: "weekly-plan" });
    await env.DB.prepare("UPDATE file_assets SET slug = 'weekly-plan-v2' WHERE id = ?").bind(page.id).run();
    expect((await api("/p/weekly-plan-v2")).status).toBe(200);
    expect((await api("/p/weekly-plan")).status).toBe(404);
  });

  it("kill switch 410s, re-enable serves, delete 404s", async () => {
    const uid = await newUser();
    const page = await seedPage(uid, HTML);
    await env.DB.prepare("UPDATE file_assets SET revoked_at = ? WHERE id = ?").bind(iso(), page.id).run();
    const gone = await api(`/p/${page.slug}`);
    expect(gone.status).toBe(410);
    expect((await gone.text()).toLowerCase()).toContain("revoked");
    expect((await api(`/f/${page.shortCode}`)).status).toBe(410);

    await env.DB.prepare("UPDATE file_assets SET revoked_at = NULL WHERE id = ?").bind(page.id).run();
    expect((await api(`/p/${page.slug}`)).status).toBe(200);

    await env.DB.prepare("UPDATE file_assets SET status = 'deleted' WHERE id = ?").bind(page.id).run();
    expect((await api(`/p/${page.slug}`)).status).toBe(404);
    expect((await api(`/f/${page.shortCode}`)).status).toBe(404);
  });
});

describe("visitor identity, revisit, dwell (test_beam_pages.py)", () => {
  it("tracks visitor + revisit and accepts dwell beacons", async () => {
    const uid = await newUser();
    const page = await seedPage(uid, HTML);
    const first = await api(`/p/${page.slug}`, { headers: { "CF-Connecting-IP": "24.48.0.1" } });
    const vid = /cb_vid=([^;]+)/.exec(first.headers.get("set-cookie") ?? "")![1];
    expect(vid).toBeTruthy();
    const second = await api(`/p/${page.slug}`, { headers: { cookie: `cb_vid=${vid}` } });
    expect(second.status).toBe(200);
    // Same visitor keeps their id.
    expect(second.headers.get("set-cookie")).toContain(`cb_vid=${vid};`);

    let evs = await rows("SELECT visitor_id, is_revisit, ip_address FROM click_events WHERE file_id = ? ORDER BY clicked_at", page.id);
    expect(evs.map((e) => e.visitor_id)).toEqual([vid, vid]);
    expect(evs.map((e) => e.is_revisit)).toEqual([0, 0]);
    expect(evs[0].ip_address).toBe("24.48.0.1");

    // Backdate both views past the revisit window.
    await env.DB.prepare("UPDATE click_events SET clicked_at = ? WHERE file_id = ?").bind(iso(-31 * 60_000), page.id).run();
    expect((await api(`/p/${page.slug}`, { headers: { cookie: `cb_vid=${vid}` } })).status).toBe(200);
    const other = await api(`/p/${page.slug}`);
    const otherVid = /cb_vid=([^;]+)/.exec(other.headers.get("set-cookie") ?? "")![1];
    expect(otherVid).not.toBe(vid);

    evs = await rows("SELECT visitor_id, is_revisit FROM click_events WHERE file_id = ?", page.id);
    expect(evs.length).toBe(4);
    expect(new Set(evs.map((e) => e.visitor_id)).size).toBe(2);
    expect(evs.filter((e) => e.is_revisit).length).toBe(1);
    expect((await row("SELECT view_count FROM file_assets WHERE id = ?", page.id))!.view_count).toBe(4);

    for (const [sid, ms] of [["s1", 12000], ["s2", 4000]] as const) {
      const r = await api(`/f/${page.shortCode}/page-events`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `cb_vid=${vid}` },
        body: JSON.stringify({ session_id: sid, events: [{ page: 0, dwell_ms: ms }] }),
      });
      expect(r.status).toBe(204);
    }
    const clamp = await api(`/f/${page.shortCode}/page-events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: "s1", events: [{ page: 0, dwell_ms: 999999 }] }),
    });
    expect(clamp.status).toBe(204);
    const dwell = await row("SELECT SUM(dwell_ms) AS total, COUNT(DISTINCT session_id) AS sessions FROM page_engagements WHERE file_id = ?", page.id);
    expect(dwell).toEqual({ total: 12000 + 4000 + 60000, sessions: 2 });
  });

  it("beacon and unlock scoped by custom host with owner fallback", async () => {
    const uid = await newUser();
    const page = await seedPage(uid, HTML, { accessCode: "4321" });
    const host = `links-${crypto.randomUUID().slice(0, 6)}.example.com`;
    await seedDomain(uid, host);

    const r = await api(`https://${host}/f/${page.shortCode}/page-events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: "s", events: [{ page: 0, dwell_ms: 100 }] }),
    });
    expect(r.status).toBe(204);
    const unlocked = await api(`https://${host}/f/${page.shortCode}/unlock-code`, form({ code: "4321" }));
    expect(unlocked.status).toBe(303);
    await env.DB.prepare("UPDATE file_assets SET access_code_hash = NULL WHERE id = ?").bind(page.id).run();
    expect((await api(`https://${host}/p/${page.slug}`)).status).toBe(200);
    expect((await api(`https://nobody.example.com/p/${page.slug}`)).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Access code (test_access_code.py)
// ---------------------------------------------------------------------------

const SECRET = "<html><head></head><body>secret plan</body></html>";

async function setCode(id: string, c: string | null) {
  const hash = c ? await hashAccessCode(settings(), id, c) : null;
  await env.DB.prepare("UPDATE file_assets SET access_code_hash = ? WHERE id = ?").bind(hash, id).run();
}

describe("access-code gate (test_access_code.py)", () => {
  it("gate flow", async () => {
    const uid = await newUser();
    const page = await seedPage(uid, SECRET, { accessCode: "483920" });
    const jar = new Jar();

    const gate = await jar.fetch(`/p/${page.slug}`);
    const gateText = await gate.text();
    expect(gate.status).toBe(200);
    expect(gateText).toContain("Enter the access code");
    expect(gateText).not.toContain("secret plan");
    expect(gateText).toContain(`action="/f/${page.shortCode}/unlock-code"`);

    const wrong = await jar.fetch(`/f/${page.shortCode}/unlock-code`, form({ code: "000000" }));
    expect(wrong.status).toBe(200);
    expect(await wrong.text()).toContain("isn’t right");
    const tl = await rows("SELECT event_type, ref FROM page_events WHERE page_id = ?", page.id);
    expect(tl).toContainEqual({ event_type: "gate_failed", ref: "code" });

    const ok = await jar.fetch(`/p/${page.slug}/unlock-code`, form({ code: "483920" }));
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe(`/p/${page.slug}`);
    expect(ok.headers.get("set-cookie")).toMatch(
      new RegExp(`^cbcode_${page.shortCode}=[0-9a-f]{32}; HttpOnly; Max-Age=2592000; Path=/; SameSite=lax; Secure$`),
    );

    const served = await jar.fetch(`/p/${page.slug}`);
    expect(served.status).toBe(200);
    expect(await served.text()).toContain("secret plan");

    // Changing the code invalidates the cookie.
    await setCode(page.id, "1234");
    expect(await (await jar.fetch(`/p/${page.slug}`)).text()).toContain("Enter the access code");
    // Clearing removes the gate entirely.
    await setCode(page.id, null);
    expect(await (await jar.fetch(`/p/${page.slug}`)).text()).toContain("secret plan");
    // No code set -> unlock just bounces back.
    const bounce = await api(`/f/${page.shortCode}/unlock-code`, form({ code: "1" }));
    expect(bounce.status).toBe(303);
    expect(bounce.headers.get("location")).toBe(`/p/${page.slug}`);
  });

  it("code gate precedes the email gate and composes", async () => {
    const uid = await newUser();
    const page = await seedPage(uid, SECRET, { accessCode: "483920", require_email: true });
    const jar = new Jar();
    const first = await (await jar.fetch(`/p/${page.slug}`)).text();
    expect(first).toContain("Enter the access code");
    expect(first.toLowerCase().split("<form")[0]).not.toContain("email");
    await jar.fetch(`/f/${page.shortCode}/unlock-code`, form({ code: "483920" }));
    expect(await (await jar.fetch(`/p/${page.slug}`)).text()).toContain("Enter your email");
    await jar.fetch(`/f/${page.shortCode}/unlock`, form({ email: "deep@example.com" }));
    expect(await (await jar.fetch(`/p/${page.slug}`)).text()).toContain("secret plan");
  });

  it("attempt limit", async () => {
    const uid = await newUser();
    const page = await seedPage(uid, SECRET, { accessCode: "483920" });
    const ip = "203.0.113.77";
    // Pre-load this IP's window counter past the limit (redis incr -> 6).
    const window = Math.floor(Date.now() / 1000 / 600);
    await env.DB.prepare("INSERT INTO rate_counters (key, count, expires_at) VALUES (?, 5, ?)")
      .bind(`code_rl:${page.id}:${ip}:${window}`, Math.floor(Date.now() / 1000) + 600)
      .run();
    const limited = await api(`/f/${page.shortCode}/unlock-code`, { ...form({ code: "483920" }), headers: { ...form({}).headers, "CF-Connecting-IP": ip } });
    expect(limited.status).toBe(429);
    expect(await limited.text()).toContain("Too many attempts");
  });

  it("unknown page -> 404", async () => {
    const r = await api("/p/no-such-page/unlock-code", form({ code: "1234" }));
    expect(r.status).toBe(404);
    expect(await r.text()).toBe("Page not found.");
  });
});
