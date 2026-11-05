/**
 * /api/v1/analytics/journeys: two-city ordering, the 30 minute collapse, the
 * shared scanner rule, scope (own vs another user vs org admin), dwell, and
 * that no IP or user agent ever leaves the Worker.
 */
import { describe, expect, it } from "vitest";
import { api, authedUser, env, json } from "./helpers";
import { member, seedTeam, useRouteTestHooks } from "./orgTestUtils";
import { code, seedFile, seedLink } from "./serveSeed";

useRouteTestHooks();

const T0 = Date.now() - 3 * 86_400_000;
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

async function click(asset: { link?: string; file?: string }, o: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = {
    id: crypto.randomUUID(), link_id: asset.link ?? null, file_id: asset.file ?? null, visitor_id: "v1",
    is_revisit: 0, is_vpn: 0, ip_address: "203.0.113.77", user_agent: "SecretAgent/9", device_type: "desktop",
    clicked_at: at(0), ...o,
  };
  const cols = Object.keys(row);
  await env.DB.prepare(`INSERT INTO click_events (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).bind(...cols.map((k) => row[k])).run();
}
const BLR = { city: "Bengaluru", country: "India", country_code: "IN", latitude: 12.97, longitude: 77.59 };
const NYC = { city: "New York", country: "United States", country_code: "US", latitude: 40.71, longitude: -74.0 };
const one = (path: string, headers: Record<string, string>) => api(`/api/v1/analytics/journeys${path}`, { headers });

describe("journeys", () => {
  it("returns a two-city journey in time order, forwarded, with no IP or UA", async () => {
    const u = await authedUser();
    const link = await seedLink(u.user.id, code(), { anchor_text: "Deck link" });
    const file = await seedFile(u.user.id, { filename: "pricing.pdf" });
    await click({ file: file.id }, { ...NYC, clicked_at: at(300) });
    await click({ link }, { ...BLR, clicked_at: at(0) });
    await click({ link }, { visitor_id: null, clicked_at: at(5) });
    await click({ link }, { visitor_id: "other", clicked_at: at(6) });

    const res = await one(`?asset_type=link&asset_id=${link}`, u.headers);
    expect(res.status).toBe(200);
    const body = await json(res);
    const j = body.journeys.find((x: any) => x.visitor_id === "v1");
    expect(j.touches.map((t: any) => [t.asset.type, t.city])).toEqual([["link", "Bengaluru"], ["file", "New York"]]);
    expect(j.touches[0].asset).toMatchObject({ id: link, title: "Deck link" });
    expect(j.touches[1].asset.title).toBe("pricing.pdf");
    expect(j.touches[0]).toMatchObject({ lat: 12.97, lon: 77.59, country_code: "IN", count: 1, dwell_ms: null });
    expect(j).toMatchObject({ cities: 2, forwarded: true, company_name: null, first_at: at(0), last_at: at(300) });
    expect(body.meta.unattributed).toBe(1);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("203.0.113.77");
    expect(raw).not.toContain("SecretAgent");
  });

  it("collapses same-asset touches within 30 minutes, not beyond", async () => {
    const u = await authedUser();
    const link = await seedLink(u.user.id, code());
    for (const m of [0, 20, 45, 120]) await click({ link }, { ...BLR, clicked_at: at(m) });
    const j = (await json(await one(`?asset_type=link&asset_id=${link}`, u.headers))).journeys[0];
    expect(j.touches.map((t: any) => t.count)).toEqual([3, 1]);
    expect(j.forwarded).toBe(false);
  });

  it("drops scanner (bot) clicks and sums dwell onto the touch", async () => {
    const u = await authedUser();
    const file = await seedFile(u.user.id);
    await click({ file: file.id }, { ...BLR, clicked_at: at(0) });
    await click({ file: file.id }, { visitor_id: "scan", device_type: "bot", clicked_at: at(1) });
    for (const ms of [4000, 6000]) {
      await env.DB.prepare("INSERT INTO page_engagements (id, file_id, session_id, visitor_id, page, dwell_ms, created_at) VALUES (?,?,?,?,?,?,?)")
        .bind(crypto.randomUUID(), file.id, "s1", "v1", 1, ms, at(2)).run();
    }
    const body = await json(await one(`?asset_type=file&asset_id=${file.id}`, u.headers));
    expect(body.journeys.map((x: any) => x.visitor_id)).toEqual(["v1"]);
    expect(body.journeys[0].touches[0].dwell_ms).toBe(10000);
  });

  it("denies another user's asset and lists only own assets in top", async () => {
    const a = await authedUser();
    const b = await authedUser();
    const mine = await seedLink(a.user.id, code());
    const theirs = await seedLink(b.user.id, code());
    await click({ link: mine }, { ...BLR });
    await click({ link: theirs }, { ...BLR, visitor_id: "theirs" });
    expect((await one(`?asset_type=link&asset_id=${theirs}`, a.headers)).status).toBe(404);
    const top = await json(await api("/api/v1/analytics/journeys/top", { headers: a.headers }));
    expect(top.journeys.map((x: any) => x.visitor_id)).toEqual(["v1"]);
  });

  it("top ranks by distinct cities, then touches", async () => {
    const u = await authedUser();
    const link = await seedLink(u.user.id, code());
    await click({ link }, { visitor_id: "busy", ...BLR, clicked_at: at(0) });
    await click({ link }, { visitor_id: "busy", ...BLR, clicked_at: at(100) });
    await click({ link }, { visitor_id: "busy", ...BLR, clicked_at: at(200) });
    await click({ link }, { visitor_id: "fwd", ...BLR, clicked_at: at(0) });
    await click({ link }, { visitor_id: "fwd", ...NYC, clicked_at: at(400) });
    const top = await json(await api("/api/v1/analytics/journeys/top", { headers: u.headers }));
    expect(top.journeys.map((x: any) => x.visitor_id)).toEqual(["fwd", "busy"]);
  });

  it("org admin sees members' assets; a member sees only their own", async () => {
    const t = await seedTeam();
    const org = (await env.DB.prepare("SELECT id FROM organizations WHERE clerk_org_id = ?").bind(t.org).first<{ id: string }>())!.id;
    const l1 = await seedLink(t.rep1.userId, code(), { organization_id: org });
    const l2 = await seedLink(t.rep2.userId, code(), { organization_id: org });
    await click({ link: l1 }, { visitor_id: "a", ...BLR });
    await click({ link: l2 }, { visitor_id: "b", ...NYC });
    const ids = async (who: { headers: Record<string, string> }) =>
      (await json(await api("/api/v1/analytics/journeys/top", { headers: who.headers }))).journeys.map((x: any) => x.visitor_id).sort();
    expect(await ids(t.admin)).toEqual(["a", "b"]);
    expect(await ids(t.rep1)).toEqual(["a"]);
    expect((await one(`?asset_type=link&asset_id=${l2}`, t.rep1.headers)).status).toBe(404);
    expect((await one(`?asset_type=link&asset_id=${l2}`, t.admin.headers)).status).toBe(200);
    const stranger = await member(`org_${crypto.randomUUID().slice(0, 8)}`, "admin");
    expect((await one(`?asset_type=link&asset_id=${l1}`, stranger.headers)).status).toBe(404);
    const viewer = await member(t.org, "viewer");
    expect((await api("/api/v1/analytics/journeys/top", { headers: viewer.headers })).status).toBe(403);
  });
});
