/**
 * Railway exit: the Worker answers for share.lakeb2b.com once IT repoints the hostname. Proves, with the
 * Host header Cloudflare sends for a custom hostname, which Worker vars make that host serve and mint.
 * The steps named here are the ones in RAILWAY_EXIT.md (step 5 recognise the host, step 9 mint on it).
 *
 *   serve: src/lib/shareOrigin.ts:21 (guard), src/env.ts:216 isPlatformHost, src/routes/redirect.ts:84 (/r, /s),
 *          src/routes/filesServe.ts:338-341 (/f, /p) via src/services/assetLookup.ts:28 resolveDomain.
 *   mint:  src/routes/_files.ts:134-157 serveHost (file URLs), src/routes/_utmHelpers.ts:126 and src/routes/utm.ts:236 (/r, /s).
 */
import { describe, expect, it } from "vitest";
import { app } from "../src/app";
import { getSettings, type Env } from "../src/env";
import { getDb } from "../src/db/client";
import { serveHost } from "../src/routes/_files";
import { apiKeyHeaders, createApiKey, env } from "./helpers";
import { code, newUser, row, seedFile, seedLink } from "./serveSeed";

const SHARE = "share.lakeb2b.com";
const APP_HOSTS = "champbeam.com,www.champbeam.com,champbeam.deep-ae0.workers.dev";

// worker/wrangler.jsonc vars today, then after each cutover step.
const TODAY = { PLATFORM_REDIRECT_HOST: APP_HOSTS, REDIRECT_BASE_URL: "https://champbeam.com", SHARE_ORIGIN_HOSTS: "" };
const RECOGNISE = { ...TODAY, PLATFORM_REDIRECT_HOST: `${APP_HOSTS},${SHARE}` };
const MINT = { ...TODAY, PLATFORM_REDIRECT_HOST: `${SHARE},${APP_HOSTS}`, REDIRECT_BASE_URL: `https://${SHARE}` };

const assets = { fetch: async () => new Response("spa") } as unknown as Fetcher;
const at = (host: string, path: string, vars: Record<string, string>, init: RequestInit = {}) =>
  app.request(`https://${host}${path}`, { redirect: "manual", ...init }, { ...(env as unknown as Env), ...vars, ASSETS: assets });

describe("share.lakeb2b.com on the Worker", () => {
  it("is refused while the host is not in PLATFORM_REDIRECT_HOST (today's production vars)", async () => {
    const uid = await newUser();
    const sc = code("t");
    const lid = await seedLink(uid, sc);
    const f = await seedFile(uid, { body: "pdfbytes" });
    const r = await at(SHARE, `/r/${sc}`, TODAY);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/"); // unknown custom host: no redirect to the destination
    expect((await at(SHARE, `/f/${f.shortCode}`, TODAY)).status).toBe(404);
    expect((await row("SELECT click_count FROM link_clicks WHERE id = ?", lid))!.click_count).toBe(0);
  });

  it("Host: share.lakeb2b.com reaches /health, /r, /s and /f once the host is recognised (cutover step 5)", async () => {
    const uid = await newUser();
    const sc = code("r");
    const lid = await seedLink(uid, sc);
    const f = await seedFile(uid, { body: "pdfbytes" });

    expect((await at(SHARE, "/health", RECOGNISE)).status).toBe(200);
    for (const prefix of ["r", "s"]) {
      const r = await at(SHARE, `/${prefix}/${sc}`, RECOGNISE, { headers: { "CF-Connecting-IP": "203.0.113.9" } });
      expect(r.status).toBe(302);
      expect(r.headers.get("location")).toBe("https://example.com/dest");
    }
    expect((await row("SELECT click_count FROM link_clicks WHERE id = ?", lid))!.click_count).toBe(2);

    const served = await at(SHARE, `/f/${f.shortCode}/deck.pdf`, RECOGNISE, { headers: { "CF-Connecting-IP": "203.0.113.9" } });
    expect(served.status).toBe(200);
    expect(new TextDecoder().decode(await served.arrayBuffer())).toBe("pdfbytes");
    expect((await row("SELECT view_count FROM file_assets WHERE id = ?", f.id))!.view_count).toBe(1);
  });

  it("keeps /api/v1 working on the share host for API-key callers (it is not a share plane)", async () => {
    const key = await createApiKey(await newUser());
    const r = await at(SHARE, "/api/v1/utm/presets", RECOGNISE, { headers: apiKeyHeaders(key) });
    expect(r.status).toBe(200);
  });

  it("mints links and file URLs on share.lakeb2b.com after the minting flip (cutover step 9)", async () => {
    const uid = await newUser();
    const key = await createApiKey(uid);
    // A request that arrives on the app host still mints on the share host.
    const gen = await at("champbeam.com", "/api/v1/utm/generate", MINT, {
      method: "POST",
      headers: { ...apiKeyHeaders(key), "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://acme.com/x", utm_campaign: "q3" }),
    });
    expect(gen.status).toBe(200);
    const d = (await gen.json()) as any;
    expect(d.redirect_url).toBe(`https://${SHARE}/r/${d.short_code}`);
    expect(d.short_url).toBe(`https://${SHARE}/s/${d.short_code}`);

    expect(await serveHost(getDb(env.DB), getSettings({ ...(env as unknown as Env), ...MINT }), uid, null)).toBe(SHARE);
    expect(await serveHost(getDb(env.DB), getSettings({ ...(env as unknown as Env), ...TODAY }), uid, null)).toBe("champbeam.com");
  });
});
