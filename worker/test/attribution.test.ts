/** Link attribution slice 1: cb_id passthrough, channel, visitor type, scanner flag. */
import { describe, expect, it } from "vitest";
import { classifyChannel, classifyVisitor, detectScanner } from "../src/services/attribution";
import { api } from "./helpers";
import { code, newUser, row, seedLink } from "./serveSeed";

describe("classifiers", () => {
  const ch = (referrer: string | null, utmMedium: string | null = null, utmSource: string | null = null) =>
    classifyChannel({ referrer, utmMedium, utmSource });

  it("channels", () => {
    expect(ch(null, "email")).toBe("email");
    expect(ch("https://www.linkedin.com/")).toBe("organic_social");
    expect(ch(null, "cpc", "linkedin")).toBe("paid_social");
    expect(ch(null, "cpc", "google")).toBe("search");
    expect(ch("https://www.google.co.in/")).toBe("search");
    expect(ch(null, "qr")).toBe("qr");
    expect(ch("https://partner.example.org/post")).toBe("referral");
    expect(ch("android-app://com.slack")).toBe("in_app");
    expect(ch(null)).toBe("direct");
  });

  it("scanner rules", () => {
    const base = { method: "GET", userAgent: "Mozilla/5.0", asnOrg: "Comcast", acceptLanguage: "en" };
    expect(detectScanner(base)).toBe(false);
    expect(detectScanner({ ...base, method: "HEAD" })).toBe(true);
    expect(detectScanner({ ...base, userAgent: "Mimecast-URL-Scanner" })).toBe(true);
    expect(detectScanner({ ...base, asnOrg: "Proofpoint, Inc." })).toBe(true);
    expect(detectScanner({ ...base, asnOrg: "Amazon Web Services hosting", acceptLanguage: null })).toBe(true);
    expect(detectScanner({ ...base, asnOrg: "Amazon Web Services hosting" })).toBe(false);
  });

  it("visitor types", () => {
    const v = { isScanner: false, deviceType: "desktop", isVpn: false, asnOrg: null, companyType: null };
    expect(classifyVisitor(v)).toBeNull();
    expect(classifyVisitor({ ...v, isScanner: true })).toBe("scanner");
    expect(classifyVisitor({ ...v, deviceType: "bot" })).toBe("bot");
    expect(classifyVisitor({ ...v, companyType: "hosting" })).toBe("hosting");
    expect(classifyVisitor({ ...v, isVpn: true })).toBe("vpn");
    expect(classifyVisitor({ ...v, companyType: "business" })).toBe("business");
    expect(classifyVisitor({ ...v, companyType: "isp", deviceType: "mobile" })).toBe("mobile");
    expect(classifyVisitor({ ...v, companyType: "isp" })).toBe("residential");
  });
});

describe("redirect attribution", () => {
  it("appends cb_id = click event id only when track_conversions is on", async () => {
    const uid = await newUser();
    const on = code("t");
    const lid = await seedLink(uid, on, { track_conversions: 1, original_url: "https://example.com/p?a=1", tracked_url: "https://example.com/p?a=1", utm_medium: "email" });
    const r = await api(`/r/${on}`, { headers: { "CF-Connecting-IP": "10.2.0.1", "Accept-Language": "en", Referer: "https://www.linkedin.com/" } });
    const loc = new URL(r.headers.get("location")!);
    expect(loc.searchParams.get("a")).toBe("1");
    const ev = await row("SELECT id, channel, is_scanner FROM click_events WHERE link_id = ?", lid);
    expect(loc.searchParams.get("cb_id")).toBe(ev!.id);
    expect(ev).toMatchObject({ channel: "email", is_scanner: 0 });

    const off = code("o");
    await seedLink(uid, off);
    const r2 = await api(`/r/${off}`);
    expect(r2.headers.get("location")).toBe("https://example.com/dest");
  });

  it("flags a HEAD prefetch as scanner but still records and redirects", async () => {
    const uid = await newUser();
    const sc = code("h");
    const lid = await seedLink(uid, sc);
    const r = await api(`/r/${sc}`, { method: "HEAD" });
    expect(r.status).toBe(302);
    expect(await row("SELECT is_scanner, visitor_type FROM click_events WHERE link_id = ?", lid)).toMatchObject({
      is_scanner: 1,
      visitor_type: "scanner",
    });
  });

  it("track_conversions toggles through PUT /links/:id/access", async () => {
    const { createUser, createApiKey, apiKeyHeaders } = await import("./helpers");
    const u = await createUser();
    const headers = apiKeyHeaders(await createApiKey(u.id));
    const lid = await seedLink(u.id, code("a"));
    const res = await api(`/api/v1/utm/links/${lid}/access`, { method: "PUT", json: { track_conversions: true }, headers });
    expect(res.status).toBe(200);
    expect((await res.json()) as any).toMatchObject({ track_conversions: true });
  });
});
