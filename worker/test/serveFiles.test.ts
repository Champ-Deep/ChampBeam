/**
 * Public file serve path (/f). Ports the file cases of
 * backend/tests/test_access_controls.py, test_page_engagement.py (ingest; the
 * owner rollup endpoint belongs to the files router, so the stored rows are
 * checked directly), test_beam_pages.py::test_non_html_file_is_not_injected,
 * plus streaming/Range coverage.
 */
import { describe, expect, it } from "vitest";
import { api, env } from "./helpers";
import { code, eventually, form, iso, Jar, newUser, row, rows, seedDomain, seedFile, setSettings } from "./serveSeed";

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

describe("file access controls (test_access_controls.py)", () => {
  it("view cap trips the serve gate", async () => {
    const uid = await newUser();
    const f = await seedFile(uid, { max_views: 1, view_count: 1, body: "pdfbytes" });
    const served = await api(`/f/${f.shortCode}`, { headers: { "X-Forwarded-For": "1.1.1.2" } });
    expect(served.status).toBe(410);
    expect(await served.text()).toContain("View limit reached");
  });

  it("email gate captures the lead", async () => {
    const uid = await newUser();
    const f = await seedFile(uid, { require_email: true, body: "pdfbytes" });
    const jar = new Jar();
    const g = await jar.fetch(`/f/${f.shortCode}`);
    expect(g.status).toBe(200);
    expect(await g.text()).toContain("Enter your email");
    const ok = await jar.fetch(`/f/${f.shortCode}/unlock`, form({ email: "lead@corp.com" }));
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe(`/f/${f.shortCode}`);
    const leads = await rows("SELECT email FROM access_leads WHERE file_id = ?", f.id);
    expect(leads.map((l) => l.email)).toEqual(["lead@corp.com"]);
    // F3: gate cookie is Secure on https (test requests are https), plain on http.
    expect(ok.headers.get("set-cookie")).toMatch(/^cbgate_.*; SameSite=lax; Secure$/);
    const mail = form({ email: "lead@corp.com" });
    const http = await api(`/f/${f.shortCode}/unlock`, { ...mail, headers: { ...mail.headers, "X-Forwarded-Proto": "http" } });
    expect(http.headers.get("set-cookie")).not.toContain("Secure");
    // Cookie in the jar -> served.
    const served = await jar.fetch(`/f/${f.shortCode}`);
    expect(served.status).toBe(200);
    expect(await served.text()).toBe("pdfbytes");

    const bad = await api(`/f/${f.shortCode}/unlock`, form({ email: "x" }));
    expect(bad.status).toBe(200);
    expect(await bad.text()).toContain("Please enter a valid email.");
  });

  it("revoked and expired files are blocked; expiry reclaims the asset", async () => {
    const uid = await newUser();
    const rev = await seedFile(uid, { revoked_at: iso(), body: "x" });
    expect((await api(`/f/${rev.shortCode}`)).status).toBe(410);

    const exp = await seedFile(uid, { expires_at: iso(-1000), body: "x" });
    const r = await api(`/f/${exp.shortCode}`);
    expect(r.status).toBe(410);
    expect(await r.text()).toContain("Link expired");
    const status = await eventually(async () => {
      const s = (await row("SELECT status FROM file_assets WHERE id = ?", exp.id))!.status;
      return s === "deleted" ? s : null;
    });
    expect(status).toBe("deleted");
    expect(await eventually(async () => (await env.FILES.head(exp.storageKey)) === null)).toBe(true);
  });

  it("unknown code, inactive status and unknown host are 404", async () => {
    const uid = await newUser();
    expect((await api("/f/doesnotexist")).status).toBe(404);
    const pending = await seedFile(uid, { status: "pending_upload", body: "x" });
    const p = await api(`/f/${pending.shortCode}`);
    expect(p.status).toBe(404);
    expect(await p.text()).toBe("File not found.");
    const f = await seedFile(uid, { body: "x" });
    expect((await api(`https://nobody.example.org/f/${f.shortCode}`)).status).toBe(404);
  });
});

describe("serving", () => {
  it("non-html file is streamed as-is with tracking cookie", async () => {
    const uid = await newUser();
    const f = await seedFile(uid, { kind: "other", mime: "text/plain", filename: "a.txt", body: "just text" });
    // KIND_OTHER downloads; the cosmetic slug segment is ignored.
    const r = await api(`/f/${f.shortCode}/whatever-slug`, { headers: { "CF-Connecting-IP": "10.9.9.9" } });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("just text");
    expect(r.headers.get("cache-control")).toBe("private, max-age=300");
    expect(r.headers.get("content-type")).toBe("text/plain");
    expect(r.headers.get("content-disposition")).toBe('attachment; filename="a.txt"');
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    expect(r.headers.get("content-security-policy")).toBeNull();
    expect(r.headers.get("set-cookie")).toMatch(/^cb_vid=[A-Za-z0-9_-]+; HttpOnly; Max-Age=31536000; Path=\/; SameSite=lax; Secure$/);

    const a = await row("SELECT view_count FROM file_assets WHERE id = ?", f.id);
    expect(a!.view_count).toBe(1);
    const ev = await row("SELECT ip_address, visitor_id, is_revisit FROM click_events WHERE file_id = ?", f.id);
    expect(ev).toMatchObject({ ip_address: "10.9.9.9", is_revisit: 0 });
    expect(ev!.visitor_id).toBeTruthy();
  });

  it("no Secure flag on plain http", async () => {
    const uid = await newUser();
    const f = await seedFile(uid, { body: "x" });
    const r = await api(`/f/${f.shortCode}`, { headers: { "X-Forwarded-Proto": "http" } });
    expect(r.headers.get("set-cookie")).not.toContain("Secure");
  });

  it("supports Range requests for video seeking", async () => {
    const uid = await newUser();
    const bytes = new Uint8Array(1000).map((_, i) => i % 256);
    const f = await seedFile(uid, { kind: "video", mime: "video/mp4", filename: "clip.mp4", body: bytes });

    const full = await api(`/f/${f.shortCode}`);
    expect(full.status).toBe(200);
    expect(full.headers.get("accept-ranges")).toBe("bytes");
    expect(full.headers.get("content-length")).toBe("1000");
    expect(new Uint8Array(await full.arrayBuffer())).toEqual(bytes);

    const first = await api(`/f/${f.shortCode}`, { headers: { Range: "bytes=0-99" } });
    expect(first.status).toBe(206);
    expect(first.headers.get("content-range")).toBe("bytes 0-99/1000");
    expect(first.headers.get("content-length")).toBe("100");
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(bytes.slice(0, 100));

    const seek = await api(`/f/${f.shortCode}`, { headers: { Range: "bytes=900-" } });
    expect(seek.status).toBe(206);
    expect(seek.headers.get("content-range")).toBe("bytes 900-999/1000");
    expect(new Uint8Array(await seek.arrayBuffer())).toEqual(bytes.slice(900));

    const suffix = await api(`/f/${f.shortCode}`, { headers: { Range: "bytes=-10" } });
    expect(suffix.status).toBe(206);
    expect(suffix.headers.get("content-range")).toBe("bytes 990-999/1000");

    const bad = await api(`/f/${f.shortCode}`, { headers: { Range: "bytes=5000-" } });
    expect(bad.status).toBe(416);
    expect(bad.headers.get("content-range")).toBe("bytes */1000");
    await bad.arrayBuffer();

    // Seeks don't count as new views: full + bytes=0-99 counted, the rest not.
    expect((await row("SELECT view_count FROM file_assets WHERE id = ?", f.id))!.view_count).toBe(2);
  });

  it("missing blob -> 502", async () => {
    const uid = await newUser();
    const f = await seedFile(uid); // no body stored
    const r = await api(`/f/${f.shortCode}`);
    expect(r.status).toBe(502);
    expect(await r.text()).toBe("Storage error.");
  });

  it("redirect serve mode uses a presigned R2 URL when configured", async () => {
    const uid = await newUser();
    const f = await seedFile(uid, { kind: "video", mime: "video/mp4", filename: "big.mp4", serve_mode: "redirect", body: "v" });
    setSettings({
      r2AccountId: "acct",
      r2AccessKeyId: "AKID",
      r2SecretAccessKey: "secret",
      r2BucketName: "bucket",
      r2PresignConfigured: true,
    });
    const r = await api(`/f/${f.shortCode}`);
    expect(r.status).toBe(302);
    const loc = r.headers.get("location")!;
    expect(loc).toContain("https://acct.r2.cloudflarestorage.com/bucket/");
    expect(loc).toContain("X-Amz-Signature=");
    expect((await row("SELECT view_count FROM file_assets WHERE id = ?", f.id))!.view_count).toBe(1);
  });

  it("custom domain serves the owner's platform-bucket assets", async () => {
    const uid = await newUser();
    const host = `files-${crypto.randomUUID().slice(0, 6)}.example.net`;
    await seedDomain(uid, host);
    const f = await seedFile(uid, { body: "owned" });
    const r = await api(`https://${host}/f/${f.shortCode}`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("owned");
    // Another user's domain can't reach it.
    const other = await newUser();
    const otherHost = `x-${crypto.randomUUID().slice(0, 6)}.example.net`;
    await seedDomain(other, otherHost);
    expect((await api(`https://${otherHost}/f/${f.shortCode}`)).status).toBe(404);
  });
});

describe("page engagement ingest (test_page_engagement.py)", () => {
  it("ingests per-page dwell", async () => {
    const uid = await newUser();
    const f = await seedFile(uid, { shortCode: code("doc"), body: "x" });
    const r1 = await api(`/f/${f.shortCode}/page-events`, json({ session_id: "s1", events: [{ page: 1, dwell_ms: 1000 }, { page: 2, dwell_ms: 5000 }] }));
    const r2 = await api(`/f/${f.shortCode}/page-events`, json({ session_id: "s2", events: [{ page: 1, dwell_ms: 3000 }, { page: 2, dwell_ms: 1000 }] }));
    expect([r1.status, r2.status]).toEqual([204, 204]);

    // Unknown code -> 404.
    expect((await api("/f/nope/page-events", json({ session_id: "x", events: [] }))).status).toBe(404);

    // The owner rollup (files router) aggregates these rows: avg per page.
    const agg = await rows(
      "SELECT page, AVG(dwell_ms) AS avg_ms, SUM(dwell_ms) AS total_ms, COUNT(DISTINCT session_id) AS sessions FROM page_engagements WHERE file_id = ? GROUP BY page ORDER BY page",
      f.id,
    );
    expect(agg).toEqual([
      { page: 1, avg_ms: 2000, total_ms: 4000, sessions: 2 },
      { page: 2, avg_ms: 3000, total_ms: 6000, sessions: 2 },
    ]);
  });

  it("clamps dwell, prefers the cookie visitor, validates the body", async () => {
    const uid = await newUser();
    const f = await seedFile(uid, { body: "x" });
    const r = await api(
      `/f/${f.shortCode}/page-events`,
      json({ session_id: "s9", visitor_id: "bodyvisitor1", events: [{ page: 0, dwell_ms: 999999 }] }, { cookie: "cb_vid=cookievisitor1" }),
    );
    expect(r.status).toBe(204);
    expect(await row("SELECT dwell_ms, visitor_id FROM page_engagements WHERE session_id = 's9'")).toEqual({
      dwell_ms: 60000,
      visitor_id: "cookievisitor1",
    });
    await api(`/f/${f.shortCode}/page-events`, json({ session_id: "s10", visitor_id: "bodyvisitor1", events: [{ page: 0, dwell_ms: 5 }] }));
    expect((await row("SELECT visitor_id FROM page_engagements WHERE session_id = 's10'"))!.visitor_id).toBe("bodyvisitor1");

    expect((await api(`/f/${f.shortCode}/page-events`, json({ session_id: "", events: [] }))).status).toBe(422);
    expect((await api(`/f/${f.shortCode}/page-events`, json({ session_id: "s", events: [{ page: -1, dwell_ms: 1 }] }))).status).toBe(422);
  });

  it("batches large payloads under D1's parameter cap", async () => {
    const uid = await newUser();
    const f = await seedFile(uid, { body: "x" });
    const events = Array.from({ length: 1000 }, (_, i) => ({ page: i, dwell_ms: 10 }));
    expect((await api(`/f/${f.shortCode}/page-events`, json({ session_id: "big", events }))).status).toBe(204);
    expect((await row("SELECT COUNT(*) AS n FROM page_engagements WHERE session_id = 'big'"))!.n).toBe(1000);
  });
});
