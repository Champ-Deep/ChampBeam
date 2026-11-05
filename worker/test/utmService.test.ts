/**
 * UTM service. Port of backend/tests/test_utm_service.py plus D1-level coverage
 * of the recording paths the redirect / file-serve routes rely on.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getDb } from "../src/db/client";
import { buildSettings, type Env } from "../src/env";
import type { CfGeo } from "../src/lib/request";
import * as utm from "../src/services/utm";
import { createUser } from "./helpers";

const db = () => getDb(env.DB);
const settings = buildSettings(env as unknown as Env);

// ---------------------------------------------------------------------------
// test_utm_service.py
// ---------------------------------------------------------------------------
describe("generateUtmUrl", () => {
  it("basic", () => {
    const result = utm.generateUtmUrl("https://example.com", { utm_source: "google", utm_medium: "cpc" });
    expect(result).toContain("utm_source=google");
    expect(result).toContain("utm_medium=cpc");
    expect(result.startsWith("https://example.com?")).toBe(true);
  });

  it("keeps an existing query string", () => {
    const result = utm.generateUtmUrl("https://example.com?foo=bar", { utm_source: "newsletter" });
    expect(result).toContain("foo=bar");
    expect(result).toContain("utm_source=newsletter");
  });

  it("cleans trailing ? and #", () => {
    expect(utm.generateUtmUrl("https://example.com/?", { utm_source: "x" })).toBe("https://example.com/?utm_source=x");
    expect(utm.generateUtmUrl("https://example.com#", { utm_source: "y" })).toBe("https://example.com?utm_source=y");
  });

  it("deduplicates slashes in the path", () => {
    expect(utm.generateUtmUrl("https://example.com//path///to////page", { utm_source: "z" })).toBe(
      "https://example.com/path/to/page?utm_source=z",
    );
  });

  it("matches urllib encoding: scheme added, existing params preserved/re-encoded, fragment kept", () => {
    expect(utm.generateUtmUrl("example.com/a b", { utm_campaign: "spring sale!" })).toBe(
      "https://example.com/a b?utm_campaign=spring+sale%21",
    );
    expect(utm.generateUtmUrl("https://e.com/p?utm_source=keep&x=%2F#frag", { utm_source: "new", utm_medium: "  " })).toBe(
      "https://e.com/p?utm_source=keep&x=%2F#frag",
    );
    expect(utm.generateUtmUrl("https://e.com/p?utm_source=old", { utm_source: "new" }, false)).toBe(
      "https://e.com/p?utm_source=new",
    );
    expect(utm.generateUtmUrl("https://e.com/?flag", { utm_source: "s" })).toBe("https://e.com/?flag=&utm_source=s");
    // Expected strings below were produced by the Python implementation.
    expect(utm.generateUtmUrl("localhost:8000/x", { utm_source: "s" })).toBe("localhost:8000/x?utm_source=s");
    expect(utm.generateUtmUrl("https://e.com/p;v=1?a=1&a=2&b=%E2%9C%93+x", { utm_source: "s~ é" })).toBe(
      "https://e.com/p;v=1?a=1&a=2&b=%E2%9C%93+x&utm_source=s~+%C3%A9",
    );
  });
});

describe("processBulkCsv", () => {
  it("applies defaults and per-row overrides", async () => {
    const csv = "url,utm_source\nhttps://example.com,google\nhttps://test.com,\n";
    const output = await utm.processBulkCsv(csv, { utm_medium: "email" });
    const lines = output.trim().split("\r\n");
    expect(lines[0]).toBe("url,utm_source,tracked_url,short_link,error");
    expect(lines[1]).toContain("utm_source=google");
    expect(lines[1]).toContain("utm_medium=email");
    expect(lines[2]).toContain("utm_medium=email");
  });

  it("flags invalid URLs", async () => {
    const output = await utm.processBulkCsv("url\ninvalid-url\n");
    const lines = output.trim().split("\r\n");
    expect(lines[1]).toContain("Invalid URL format");
  });

  it("requires a url column; quotes like the csv module", async () => {
    await expect(utm.processBulkCsv("link\nhttps://a.com\n")).rejects.toThrow("CSV must contain a 'url' column");
    const out = await utm.processBulkCsv('url,note\r\n"https://a.com/x,y",hello\r\n,"multi\nline"\r\n', { utm_source: "s" });
    expect(out).toBe(
      "url,note,tracked_url,short_link,error\r\n" +
        '"https://a.com/x,y",hello,"https://a.com/x,y?utm_source=s",,\r\n' +
        ',"multi\nline",,,Missing URL\r\n',
    );
  });

  it("persists trackable links and fills short_link when tracking", async () => {
    const user = await createUser();
    const out = await utm.processBulkCsv("url\nexample.com/a\nexample.com/a\n", { utm_source: "li" }, {
      db: db(),
      userId: user.id,
      shortLinkBuilder: (code) => `https://share.example.com/r/${code}`,
    });
    const lines = out.trim().split("\r\n");
    const link1 = lines[1].split(",")[2];
    expect(link1).toMatch(/^https:\/\/share\.example\.com\/r\/[A-Za-z0-9]{7}$/);
    expect(lines[2].split(",")[2]).toBe(link1); // dedup -> same short code
    const rows = await env.DB.prepare("SELECT original_url, utm_source FROM link_clicks WHERE user_id = ?").bind(user.id).all();
    expect(rows.results).toEqual([{ original_url: "https://example.com/a", utm_source: "li" }]);
  });
});

it("generateShortCode is 7 alphanumerics", () => {
  const code = utm.generateShortCode();
  expect(code).toMatch(/^[A-Za-z0-9]{7}$/);
});

// ---------------------------------------------------------------------------
// HTML injection
// ---------------------------------------------------------------------------
describe("injectUtmIntoHtml", () => {
  it("rewrites trackable links and reports metadata", () => {
    const html =
      '<p><a href="https://a.com/x">A <b>link</b></a> <a href="mailto:x@y.z">mail</a> ' +
      "<A class='c' HREF='https://b.com/?utm_source=old'>B</A> <a href=\"https://c.com\"></a></p>";
    const [out, links] = utm.injectUtmIntoHtml(html, { utm_source: "news", utm_medium: "email" });
    expect(out).toContain('href="https://a.com/x?utm_source=news&utm_medium=email"');
    expect(out).toContain('href="mailto:x@y.z"');
    expect(out).toContain("HREF='https://b.com/?utm_source=old'"); // preserved
    expect(links).toHaveLength(2);
    expect(links[0]).toMatchObject({ original_url: "https://a.com/x", anchor_text: "A link", position: 0, utm_source: "news", utm_term: null });
    expect(links[1]).toMatchObject({ original_url: "https://c.com", anchor_text: null, position: 1 });
  });
});

// ---------------------------------------------------------------------------
// D1 recording paths
// ---------------------------------------------------------------------------
async function newLink(extra: Partial<Parameters<typeof utm.recordLink>[1]> = {}) {
  const user = await createUser();
  const link = await utm.recordLink(db(), {
    userId: user.id,
    originalUrl: "https://acme.com/q3",
    trackedUrl: "https://acme.com/q3?utm_source=x",
    utmParams: { utm_source: "x" },
    ...extra,
  });
  return { user, link };
}

const linkRow = (id: string) =>
  env.DB.prepare("SELECT click_count, unique_clicks, first_clicked_at, last_clicked_at FROM link_clicks WHERE id = ?")
    .bind(id)
    .first<{ click_count: number; unique_clicks: number; first_clicked_at: string | null; last_clicked_at: string | null }>();

describe("recordLink", () => {
  it("deduplicates identical links and re-points the project", async () => {
    const { user, link } = await newLink();
    expect(link.shortCode).toMatch(/^[A-Za-z0-9]{7}$/);
    expect(link.clickCount).toBe(0);
    const projectId = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO projects (id, user_id, name, created_at, updated_at) VALUES (?,?,?,?,?)")
      .bind(projectId, user.id, "P", new Date().toISOString(), new Date().toISOString())
      .run();
    const again = await utm.recordLink(db(), {
      userId: user.id,
      originalUrl: "https://acme.com/q3",
      trackedUrl: "ignored",
      utmParams: { utm_source: "x" },
      projectId,
    });
    expect(again.id).toBe(link.id);
    expect(again.projectId).toBe(projectId);
    const other = await utm.recordLink(db(), {
      userId: user.id,
      originalUrl: "https://acme.com/q3",
      trackedUrl: "t",
      utmParams: { utm_source: "y" },
    });
    expect(other.id).not.toBe(link.id);
  });
});

describe("click recording", () => {
  it("recordClickEvent inserts the event and bumps counters atomically (unique per IP)", async () => {
    const { link } = await newLink();
    const ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
    const ev = await utm.recordClickEvent(db(), link, { ipAddress: "1.1.1.1", userAgent: ua, referrer: "https://t.co/" });
    expect(ev).toMatchObject({ linkId: link.id, deviceType: "mobile", browser: "Mobile Safari", os: "iOS", isVpn: false });
    await utm.recordClickEvent(db(), link, { ipAddress: "1.1.1.1", userAgent: null, referrer: null });
    await utm.recordClickEvent(db(), link, { ipAddress: "2.2.2.2", userAgent: null, referrer: null });
    const row = await linkRow(link.id);
    expect(row).toMatchObject({ click_count: 3, unique_clicks: 2 });
    expect(row!.first_clicked_at).not.toBeNull();
    expect(link.clickCount).toBe(3);
    expect(link.uniqueClicks).toBe(2);
  });

  it("bumpClickCounter + insertClickEvent (the redirect path)", async () => {
    const { link } = await newLink();
    const id = await utm.insertClickEvent(db(), {
      linkId: link.id,
      ipAddress: "9".repeat(60),
      userAgent: "curl/8.4.0",
      referrer: null,
    });
    const ev = await env.DB.prepare("SELECT ip_address, browser, device_type FROM click_events WHERE id = ?").bind(id).first();
    expect(ev).toEqual({ ip_address: "9".repeat(45), browser: "curl", device_type: "desktop" });
    await utm.bumpClickCounter(db(), link.id, "9".repeat(45));
    await utm.bumpClickCounter(db(), link.id, null);
    expect(await linkRow(link.id)).toMatchObject({ click_count: 2, unique_clicks: 1 });
  });

  it("consumeLinkView enforces the view cap atomically and classifies blocks", async () => {
    const { link } = await newLink();
    await env.DB.prepare("UPDATE link_clicks SET max_views = 2 WHERE id = ?").bind(link.id).run();
    const results = await Promise.all([1, 2, 3, 4].map((i) => utm.consumeLinkView(db(), link.id, `10.1.1.${i}`)));
    expect(results.filter((r) => r === "ok")).toHaveLength(2);
    expect(results.filter((r) => r === "maxed")).toHaveLength(2);
    expect((await linkRow(link.id))!.click_count).toBe(2);

    const { link: l2 } = await newLink();
    await env.DB.prepare("UPDATE link_clicks SET expires_at = ? WHERE id = ?").bind("2000-01-01T00:00:00.000Z", l2.id).run();
    expect(await utm.consumeLinkView(db(), l2.id, null)).toBe("expired");
    await env.DB.prepare("UPDATE link_clicks SET revoked_at = ? WHERE id = ?").bind(new Date().toISOString(), l2.id).run();
    expect(await utm.consumeLinkView(db(), l2.id, null)).toBe("revoked");
    expect(await utm.consumeLinkView(db(), crypto.randomUUID(), null)).toBe("gone");

    const { link: l3 } = await newLink();
    await env.DB.prepare("UPDATE link_clicks SET expires_at = ? WHERE id = ?").bind("2999-01-01T00:00:00.000Z", l3.id).run();
    expect(await utm.consumeLinkView(db(), l3.id, "1.2.3.4")).toBe("ok");
  });

  it("incrementLinkClick counts the first click as unique only", async () => {
    const { link } = await newLink();
    await utm.incrementLinkClick(db(), link.id);
    await utm.incrementLinkClick(db(), link.id);
    expect(await linkRow(link.id)).toMatchObject({ click_count: 2, unique_clicks: 1 });
  });
});

describe("file views", () => {
  it("recordFileViewEvent bumps view_count and lastFileViewAt finds the visitor's latest view", async () => {
    const user = await createUser();
    const fileId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO file_assets (id, user_id, short_code, filename, kind, mime_type, size_bytes, storage_key, status, serve_mode, view_count, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
      .bind(fileId, user.id, "fv1", "d.pdf", "pdf", "application/pdf", 1, "k", "active", "stream", 0, new Date().toISOString())
      .run();
    const file = (await env.DB.prepare("SELECT * FROM file_assets WHERE id = ?").bind(fileId).first())!;
    const asset = { id: fileId, domainId: null, viewCount: 0, lastViewedAt: null } as unknown as utm.FileAsset;
    expect(file).toBeTruthy();

    expect(await utm.lastFileViewAt(db(), fileId, "v1")).toBeNull();
    const ev = await utm.recordFileViewEvent(db(), asset, {
      ipAddress: "3.3.3.3",
      userAgent: null,
      referrer: null,
      visitorId: "v1",
      isRevisit: true,
      fileUpdates: { stateToken: "st_123" },
    });
    expect(ev).toMatchObject({ fileId, linkId: null, visitorId: "v1", isRevisit: true });
    const row = await env.DB.prepare("SELECT view_count, last_viewed_at, state_token FROM file_assets WHERE id = ?").bind(fileId).first<any>();
    expect(row.view_count).toBe(1);
    expect(row.state_token).toBe("st_123");
    expect(await utm.lastFileViewAt(db(), fileId, "v1")).toBe(ev.clickedAt);
    expect(asset.viewCount).toBe(1);
  });
});

describe("resolveGeoForEvent", () => {
  it("writes request.cf geo + heuristic VPN onto the event", async () => {
    const { link } = await newLink();
    const id = await utm.insertClickEvent(db(), { linkId: link.id, ipAddress: "49.205.201.248", userAgent: null, referrer: null });
    const cf: CfGeo = {
      country: "India", countryCode: "IN", region: "Karnataka", city: "Bengaluru",
      latitude: 12.97, longitude: 77.59, asn: 9009, asOrganization: "M247 Europe SRL",
    };
    await utm.resolveGeoForEvent({ settings, db: db() }, id, "49.205.201.248", { cf });
    const ev = await env.DB.prepare(
      "SELECT country, country_code, region, city, latitude, longitude, is_vpn, asn_org, company_name FROM click_events WHERE id = ?",
    )
      .bind(id)
      .first();
    expect(ev).toEqual({
      country: "India", country_code: "IN", region: "Karnataka", city: "Bengaluru",
      latitude: 12.97, longitude: 77.59, is_vpn: 1, asn_org: "M247 Europe SRL", company_name: null,
    });
  });

  it("no geo and no company leaves the event untouched", async () => {
    const { link } = await newLink();
    const id = await utm.insertClickEvent(db(), { linkId: link.id, ipAddress: "8.8.8.8", userAgent: null, referrer: null });
    await utm.resolveGeoForEvent({ settings, db: db() }, id, "8.8.8.8", { cf: null });
    const ev = await env.DB.prepare("SELECT country, is_vpn FROM click_events WHERE id = ?").bind(id).first();
    expect(ev).toEqual({ country: null, is_vpn: 0 });
  });
});

describe("CSV helpers", () => {
  it("parseCsv handles quotes, CRLF, blank lines", () => {
    expect(utm.parseCsv('a,b\r\n\r\n"x ""q""",\n"",z')).toEqual([["a", "b"], ['x "q"', ""], ["", "z"]]);
  });
  it("toCsvRow quotes minimally", () => {
    expect(utm.toCsvRow(["a", "b,c", 'd"e', null])).toBe('a,"b,c","d""e",\r\n');
    expect(utm.toCsvRow([""])).toBe('""\r\n');
  });
});
