/**
 * Port of backend/tests/test_champvault_library.py — the ChampVault library
 * layer: per-user favorites, and org-scoped sends recorded as a ContentShare
 * against a lazily-created shadow Content so they roll up in team analytics.
 * The external ChampVault API is mocked at the fetch layer.
 *
 * The /r/{code} re-mint assertions need routes/redirect.ts (another port) and
 * run only once it is ported (REDIRECT_PORTED).
 */
import { describe, expect, it } from "vitest";
import { api, env, json } from "./helpers";
import { REDIRECT_PORTED, VAULT, addClicks, member, mockVault, newOrgId, useRouteTestHooks } from "./orgTestUtils";

useRouteTestHooks();

/** An org with an admin + N members (_seed_org). */
async function seedOrg(members = 1) {
  const org = newOrgId();
  const admin = await member(org, "admin", "Ada Admin");
  const reps = [];
  for (let i = 0; i < members; i++) reps.push(await member(org, "member", `Member ${i}`));
  return { org, admin, reps };
}

const beam = (headers: Record<string, string>, assetId: string, body: unknown = {}) =>
  api(`/api/v1/champvault/assets/${assetId}/beam`, { method: "POST", headers, json: body });

describe("champvault favorites", () => {
  it("add, list, remove and annotation", async () => {
    const {
      reps: [m],
    } = await seedOrg();
    mockVault({
      assets: [
        { id: "a1", title: "One", type: "deck", storage: "r2", status: "published" },
        { id: "a2", title: "Two", type: "pdf", storage: "r2", status: "published" },
      ],
    });

    // Favorite a1 (idempotent: twice is still one).
    for (let i = 0; i < 2; i++) {
      expect((await api("/api/v1/champvault/assets/a1/favorite", { method: "PUT", headers: m.headers })).status).toBe(204);
    }

    // The favorites shelf resolves full asset details (works cross-search).
    const favs = await json(await api("/api/v1/champvault/favorites", { headers: m.headers }));
    expect(favs.map((f: any) => f.id)).toEqual(["a1"]);
    expect(favs[0].favorited).toBe(true);
    expect(favs[0].title).toBe("Deck a1");

    // /assets annotates the caller's favorite state.
    const assets = Object.fromEntries(
      (await json(await api("/api/v1/champvault/assets", { headers: m.headers }))).map((a: any) => [a.id, a]),
    );
    expect(assets.a1.favorited).toBe(true);
    expect(assets.a2.favorited).toBe(false);

    // Remove it (idempotent).
    for (let i = 0; i < 2; i++) {
      expect((await api("/api/v1/champvault/assets/a1/favorite", { method: "DELETE", headers: m.headers })).status).toBe(
        204,
      );
    }
    expect(await json(await api("/api/v1/champvault/favorites", { headers: m.headers }))).toEqual([]);
  });

  it("favorites shelf skips unresolvable assets", async () => {
    const {
      reps: [m],
    } = await seedOrg();
    mockVault({
      getAsset: (id) =>
        id === "gone" ? null : { id, title: `Deck ${id}`, type: "deck", storage: "r2", status: "published" },
    });
    for (const aid of ["live", "gone"]) {
      expect((await api(`/api/v1/champvault/assets/${aid}/favorite`, { method: "PUT", headers: m.headers })).status).toBe(
        204,
      );
    }
    // The unresolvable favorite is silently skipped; the live one still shows.
    const favs = await json(await api("/api/v1/champvault/favorites", { headers: m.headers }));
    expect(favs.map((f: any) => f.id)).toEqual(["live"]);
  });

  it("favorites shelf 503s when the hub is not configured", async () => {
    const {
      reps: [m],
    } = await seedOrg();
    await api("/api/v1/champvault/assets/a1/favorite", { method: "PUT", headers: m.headers });
    expect((await api("/api/v1/champvault/favorites", { headers: m.headers })).status).toBe(503);
  });
});

describe("org-scoped champvault sends", () => {
  it("org send records shadow content and shows in analytics", async () => {
    const {
      admin,
      reps: [m],
    } = await seedOrg();
    mockVault();

    // Member sends a ChampVault asset from the library.
    const resp = await beam(m.headers, "asset_deck", { expires_in_days: 7 });
    expect(resp.status).toBe(201);
    const body = await json(resp);
    expect(body.content_id).toBeTruthy();
    expect(body.link_id).toBeTruthy();
    const shortCode = body.beam_url.split("/").pop();

    // A single shadow Content + the member's ContentShare now exist.
    const content = await env.DB.prepare("SELECT * FROM content_items WHERE champvault_asset_id = ?")
      .bind("asset_deck")
      .first<{ id: string; title: string; description: string }>();
    expect(content!.title).toBe("Deck asset_deck");
    expect(content!.description).toBe("A pitch deck");
    const shares = await env.DB.prepare("SELECT * FROM content_shares WHERE content_id = ?").bind(content!.id).all();
    expect(shares.results).toHaveLength(1);
    expect(shares.results[0].shared_by_user_id).toBe(m.userId);
    expect(body.content_id).toBe(content!.id);

    // Opens on the member's beam roll up in the org analytics.
    await addClicks(body.link_id, ["9.9.9.1", "9.9.9.2", "9.9.9.2"]);
    const report = await json(await api("/api/v1/org/analytics/content", { headers: admin.headers }));
    const item = report.items.find((i: any) => i.content_id === body.content_id);
    expect(item.opens).toBe(3);
    expect(item.unique_opens).toBe(2);
    expect(item.shares).toBe(1);

    const roster = Object.fromEntries(
      (await json(await api("/api/v1/org/members", { headers: admin.headers }))).map((r: any) => [r.user_id, r]),
    );
    expect(roster[m.userId].shares).toBe(1);
    expect(roster[m.userId].opens).toBe(3);

    if (REDIRECT_PORTED) {
      // The beam still re-mints a fresh delivery URL on open.
      const r = await api(`/r/${shortCode}`, { headers: { "X-Forwarded-For": "10.0.0.9" } });
      expect(r.status).toBe(302);
      expect(r.headers.get("location")).toMatch(new RegExp(`^${VAULT}/d/asset_deck\\?v=`));
    }
  });

  it("admin adds a champvault asset to the library (CVLIB-1)", async () => {
    const {
      admin,
      reps: [m],
    } = await seedOrg();
    mockVault();

    const resp = await api("/api/v1/content/from-champvault", {
      method: "POST",
      headers: admin.headers,
      json: { asset_id: "asset_deck" },
    });
    expect(resp.status).toBe(201);
    const item = await json(resp);
    expect(item.champvault_asset_id).toBe("asset_deck");
    expect(item.title).toBe("Deck asset_deck"); // resolved from ChampVault
    expect(item.description).toBe("A pitch deck");
    expect(item.kind).toBe("link");
    const contentId = item.id;

    // Idempotent: re-adding the same asset returns the same library item.
    const again = await api("/api/v1/content/from-champvault", {
      method: "POST",
      headers: admin.headers,
      json: { asset_id: "asset_deck" },
    });
    expect(again.status).toBe(201);
    expect((await json(again)).id).toBe(contentId);

    // It shows up in the org library, and a member can share it (re-mintable).
    const lib = await json(await api("/api/v1/content", { headers: admin.headers }));
    expect(lib.some((c: any) => c.id === contentId && c.champvault_asset_id === "asset_deck")).toBe(true);

    const share = await api(`/api/v1/content/${contentId}/share`, { method: "POST", headers: m.headers, json: {} });
    expect(share.status).toBe(201);
    const shortCode = (await json(share)).share_url.split("/").pop();
    const link = await env.DB.prepare("SELECT champvault_asset_id FROM link_clicks WHERE short_code = ?")
      .bind(shortCode)
      .first<{ champvault_asset_id: string }>();
    expect(link!.champvault_asset_id).toBe("asset_deck");

    if (REDIRECT_PORTED) {
      const r = await api(`/r/${shortCode}`, { headers: { "X-Forwarded-For": "10.0.0.5" } });
      expect(r.status).toBe(302);
      expect(r.headers.get("location")).toMatch(new RegExp(`^${VAULT}/d/asset_deck\\?v=`));
    }
  });

  it("title override skips the lookup; members are forbidden (CVLIB-2)", async () => {
    const {
      admin,
      reps: [m],
    } = await seedOrg();
    const vault = mockVault();

    const resp = await api("/api/v1/content/from-champvault", {
      method: "POST",
      headers: admin.headers,
      json: { asset_id: "asset_z", title: "Custom Q3 Pitch" },
    });
    expect(resp.status).toBe(201);
    expect((await json(resp)).title).toBe("Custom Q3 Pitch");
    // A supplied title is used verbatim (no get_asset needed).
    expect(vault.calls.getAsset).toBe(0);

    // Members can't add to the library.
    const forbidden = await api("/api/v1/content/from-champvault", {
      method: "POST",
      headers: m.headers,
      json: { asset_id: "asset_y", title: "x" },
    });
    expect(forbidden.status).toBe(403);
  });

  it("from-champvault 503s when unconfigured", async () => {
    const { admin } = await seedOrg();
    const r = await api("/api/v1/content/from-champvault", {
      method: "POST",
      headers: admin.headers,
      json: { asset_id: "asset_q" },
    });
    expect(r.status).toBe(503);
    expect((await json(r)).detail).toBe("ChampVault is not configured.");
  });

  it("org send is idempotent and consolidates across members", async () => {
    const {
      admin,
      reps: [m1, m2],
    } = await seedOrg(2);
    mockVault();

    // Member 1 sends twice (idempotent -> one stable beam), member 2 sends once.
    const first = await json(await beam(m1.headers, "asset_x"));
    const second = await json(await beam(m1.headers, "asset_x"));
    expect(first.beam_url).toBe(second.beam_url);
    const third = await json(await beam(m2.headers, "asset_x"));
    expect(third.content_id).toBe(first.content_id); // one shadow content for the org

    // Exactly one shadow Content, two ContentShares (one per member).
    const contents = await env.DB.prepare("SELECT id FROM content_items WHERE champvault_asset_id = ?")
      .bind("asset_x")
      .all<{ id: string }>();
    expect(contents.results).toHaveLength(1);
    const shares = await env.DB.prepare("SELECT id FROM content_shares WHERE content_id = ?")
      .bind(contents.results[0].id)
      .all();
    expect(shares.results).toHaveLength(2);

    await addClicks(first.link_id, ["1.0.0.1", "1.0.0.2"]);
    await addClicks(third.link_id, ["2.0.0.1", "2.0.0.2", "2.0.0.3"]);

    const report = await json(await api("/api/v1/org/analytics/content", { headers: admin.headers }));
    const item = report.items.find((i: any) => i.content_id === first.content_id);
    expect(item.opens).toBe(5);
    expect(item.unique_opens).toBe(5);
    expect(item.shares).toBe(2);
    expect(item.sharing_members).toBe(2);
  });
});
