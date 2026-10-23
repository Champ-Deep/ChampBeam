/**
 * Port of backend/tests/test_champvault.py — the ChampVault connector:
 * delivery-target selection, the beam endpoint (mints a tracked link) and the
 * asset proxy. The external ChampVault API is mocked at the fetch layer.
 *
 * The "redirect re-mints a fresh delivery URL" half of
 * test_beam_mints_tracked_link_and_redirect_remints exercises GET /r/{code},
 * which belongs to the redirect router (routes/redirect.ts); it runs only once
 * that router is ported (see REDIRECT_PORTED).
 */
import { describe, expect, it } from "vitest";
import { api, authedUser, env, json } from "./helpers";
import { deliveryTarget } from "../src/routes/_champvault";
import { REDIRECT_PORTED, VAULT, mockVault, setSettings, useRouteTestHooks } from "./orgTestUtils";

useRouteTestHooks();

describe("champvault connector", () => {
  it("delivery target picks the player for video and url for file", () => {
    expect(deliveryTarget({ kind: "file", url: "https://v/d/1?sig=x" })).toBe("https://v/d/1?sig=x");
    const video = { kind: "video", hlsUrl: "https://s/h.m3u8", iframeUrl: "https://s/iframe" };
    // Video must open the embeddable player, not the raw HLS manifest.
    expect(deliveryTarget(video)).toBe("https://s/iframe");
    expect(deliveryTarget({ kind: "file" })).toBeNull();
  });

  it("beam mints a tracked link stamped with the asset id", async () => {
    const { user, headers } = await authedUser();
    const vault = mockVault();

    const resp = await api("/api/v1/champvault/assets/asset_123/beam", {
      method: "POST",
      headers,
      json: { expires_in_days: 7 },
    });
    expect(resp.status).toBe(201);
    const body = await json(resp);
    expect(body.asset_id).toBe("asset_123");
    expect(body.kind).toBe("file");
    expect(body.expires_at).toBe(9999);
    expect(body.beam_url).toMatch(/^https:\/\/share\.example\.com\/r\/\w+$/);
    const shortCode = body.beam_url.split("/").pop();

    // The link is stamped with the asset id (so the redirect knows to re-mint).
    const link = await env.DB.prepare("SELECT * FROM link_clicks WHERE short_code = ?")
      .bind(shortCode)
      .first<{ id: string; champvault_asset_id: string; user_id: string; tracked_url: string }>();
    expect(link!.champvault_asset_id).toBe("asset_123");
    expect(link!.user_id).toBe(user.id);
    expect(link!.id).toBe(body.link_id);
    expect(link!.tracked_url).toBe(`${VAULT}/d/asset_123?v=1`);

    // Re-beaming reuses the one stable link and refreshes its fallback URL.
    const again = await json(
      await api("/api/v1/champvault/assets/asset_123/beam", { method: "POST", headers, json: {} }),
    );
    expect(again.beam_url).toBe(body.beam_url);
    const refreshed = await env.DB.prepare("SELECT tracked_url FROM link_clicks WHERE id = ?")
      .bind(body.link_id)
      .first<{ tracked_url: string }>();
    expect(refreshed!.tracked_url).toBe(`${VAULT}/d/asset_123?v=2`);
    expect(vault.calls.deliver).toBe(2);

    if (REDIRECT_PORTED) {
      // Opening the beam re-mints a FRESH delivery URL (different ?v=) and redirects.
      const r = await api(`/r/${shortCode}`, { headers: { "X-Forwarded-For": "10.0.0.5" } });
      expect(r.status).toBe(302);
      expect(r.headers.get("location")).toMatch(new RegExp(`^${VAULT}/d/asset_123\\?v=`));
      expect(vault.calls.deliver).toBeGreaterThanOrEqual(3);
    }
  });

  it("beam returns 503 when not configured", async () => {
    const { headers } = await authedUser();
    setSettings({ champvaultUrl: "", champvaultApiKey: "", champvaultConfigured: false });

    const resp = await api("/api/v1/champvault/assets/x/beam", { method: "POST", headers, json: {} });
    expect(resp.status).toBe(503);
    expect((await json(resp)).detail).toBe(
      "ChampVault is not configured (set CHAMPVAULT_URL and CHAMPVAULT_API_KEY).",
    );

    const cfg = await api("/api/v1/champvault/config", { headers });
    expect(await json(cfg)).toEqual({ configured: false });
  });

  it("list assets proxies published only", async () => {
    const { headers } = await authedUser();
    const vault = mockVault({
      assets: [{ id: "a1", title: "Deck", type: "deck", storage: "r2", status: "published" }],
    });

    const resp = await api("/api/v1/champvault/assets?type=deck", { headers });
    expect(resp.status).toBe(200);
    const body = await json(resp);
    expect(body[0].title).toBe("Deck");
    expect(body[0]).toMatchObject({ id: "a1", size_bytes: null, has_thumbnail: false, tags: [], favorited: false });
    // BD-facing listing is forced to published.
    expect(vault.listParams[0].get("status")).toBe("published");
    expect(vault.listParams[0].get("type")).toBe("deck");

    expect(await json(await api("/api/v1/champvault/config", { headers }))).toEqual({ configured: true });
    expect(await json(await api("/api/v1/champvault/collections", { headers }))).toEqual([{ id: "c1", name: "Decks" }]);
    const one = await json(await api("/api/v1/champvault/assets/a9", { headers }));
    expect(one).toMatchObject({ id: "a9", title: "Deck a9" });
  });

  it("upstream errors map to 502", async () => {
    const { headers } = await authedUser();
    mockVault({ getAsset: () => null });
    const r = await api("/api/v1/champvault/assets/missing", { headers });
    expect(r.status).toBe(502);
    expect((await json(r)).detail).toMatch(/^ChampVault error: GET \/assets\/missing -> 404/);
  });

  it("requires auth", async () => {
    expect((await api("/api/v1/champvault/config")).status).toBe(401);
  });
});
