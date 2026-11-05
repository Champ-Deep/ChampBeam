/**
 * Port of backend/tests/test_rooms.py (ROOM-1..7, HTTP level) — Hosted Briefing
 * Rooms + identified visit tracking: create/publish/archive a room, mint a
 * per-recipient tokenized link, resolve it publicly with personalization,
 * ingest engagement events (identified + anonymous/forwarded), and read the
 * self-ranking engagement score.
 */
import { describe, expect, it } from "vitest";
import { api, env, json } from "./helpers";
import { member, newOrgId, useRouteTestHooks } from "./orgTestUtils";

useRouteTestHooks();

async function seedOrg() {
  return member(newOrgId(), "member", "Rep One");
}

type H = Record<string, string>;

async function makeRoom(headers: H) {
  const resp = await api("/api/v1/rooms", {
    method: "POST",
    headers,
    json: {
      title: "Ferrovial Briefing",
      bucket: "infrastructure",
      asset_ids: ["asset_deck", "asset_video"],
      personalization: { prepared_for_line: "Prepared for {{company_name}}'s leadership team" },
    },
  });
  expect(resp.status).toBe(201);
  return json(resp);
}

const post = (path: string, headers: H, body?: unknown) =>
  api(path, { method: "POST", headers, ...(body === undefined ? {} : { json: body }) });

describe("briefing rooms", () => {
  it("ROOM-1: create, publish and slug", async () => {
    const m = await seedOrg();
    const room = await makeRoom(m.headers);
    expect(room.state).toBe("draft");
    expect(room.slug.startsWith("ferrovial-briefing")).toBe(true);
    expect(room.asset_ids).toEqual(["asset_deck", "asset_video"]);
    expect(room.recipient_count).toBe(0);
    expect(room.created_at).toMatch(/Z$/);

    const pub = await post(`/api/v1/rooms/${room.id}/publish`, m.headers);
    expect(pub.status).toBe(200);
    expect((await json(pub)).state).toBe("published");

    // A second room with the same title gets a distinct slug.
    const twin = await makeRoom(m.headers);
    expect(twin.slug).not.toBe(room.slug);
  });

  it("ROOM-2: recipient link is unique and tokenized", async () => {
    const m = await seedOrg();
    const room = await makeRoom(m.headers);
    const r1 = await json(
      await post(`/api/v1/rooms/${room.id}/recipients`, m.headers, {
        name: "Ana García",
        company: "Ferrovial",
        email: "ana@ferrovial.com",
      }),
    );
    const r2 = await json(
      await post(`/api/v1/rooms/${room.id}/recipients`, m.headers, { name: "Luis Pérez", company: "Acciona" }),
    );
    expect(r1.token && r2.token && r1.token !== r2.token).toBe(true);
    expect(r1.url.endsWith(`?t=${r1.token}`)).toBe(true);
    expect(r1.url).toContain(`/rooms/${room.slug}`);
    expect(r1.bucket).toBe("infrastructure"); // inherits the room bucket

    const got = await json(await api(`/api/v1/rooms/${room.id}`, { headers: m.headers }));
    expect(got.recipient_count).toBe(2);
  });

  it("ROOM-3: public resolve personalizes by token", async () => {
    const m = await seedOrg();
    const room = await makeRoom(m.headers);
    await post(`/api/v1/rooms/${room.id}/publish`, m.headers);
    const recip = await json(
      await post(`/api/v1/rooms/${room.id}/recipients`, m.headers, { name: "Ana García", company: "Ferrovial" }),
    );

    const identified = await json(await api(`/api/v1/rooms/public/${room.slug}?t=${recip.token}`));
    expect(identified.identified).toBe(true);
    expect(identified.personalization.prepared_for_line).toBe("Prepared for Ferrovial's leadership team");
    expect(identified.asset_ids).toEqual(["asset_deck", "asset_video"]);
    expect(identified.ended).toBe(false);

    const anon = await json(await api(`/api/v1/rooms/public/${room.slug}`));
    expect(anon.identified).toBe(false);
    expect(anon.personalization.prepared_for_line).toContain("your team");
  });

  it("ROOM-4: draft hidden, archived shows ended", async () => {
    const m = await seedOrg();
    const room = await makeRoom(m.headers);

    // Draft -> not resolvable publicly.
    expect((await api(`/api/v1/rooms/public/${room.slug}`)).status).toBe(404);

    await post(`/api/v1/rooms/${room.id}/publish`, m.headers);
    expect((await api(`/api/v1/rooms/public/${room.slug}`)).status).toBe(200);

    await post(`/api/v1/rooms/${room.id}/archive`, m.headers);
    const ended = await json(await api(`/api/v1/rooms/public/${room.slug}`));
    expect(ended.state).toBe("archived");
    expect(ended.ended).toBe(true);

    // Archived rooms cannot be re-published.
    expect((await post(`/api/v1/rooms/${room.id}/publish`, m.headers)).status).toBe(409);
  });

  it("ROOM-5: track events and engagement score", async () => {
    const m = await seedOrg();
    const room = await makeRoom(m.headers);
    await post(`/api/v1/rooms/${room.id}/publish`, m.headers);
    const recip = await json(
      await post(`/api/v1/rooms/${room.id}/recipients`, m.headers, { name: "Ana García", company: "Ferrovial" }),
    );

    const track = async (type: string, payload: Record<string, unknown> = {}, sessionId = "s1") => {
      const r = await post("/api/v1/rooms/track", {}, {
        slug: room.slug,
        type,
        token: recip.token,
        session_id: sessionId,
        payload,
      });
      expect(r.status).toBe(204);
    };

    await track("page_view", {}, "s1");
    await track("video_progress", { percent: 80, asset_id: "asset_video" }, "s1");
    await track("cta_click", { kind: "booking" }, "s1");
    await track("session", { duration_s: 200 }, "s1");
    await track("page_view", {}, "s2"); // return visit (2nd session)

    const analytics = await json(await api(`/api/v1/rooms/${room.id}/analytics`, { headers: m.headers }));
    expect(analytics.recipients).toHaveLength(1);
    const me = analytics.recipients[0];
    expect(me.company).toBe("Ferrovial");
    expect(me.score).toBe(80); // 30 video + 20 return + 20 cta + 10 dwell
    expect(me.events).toBe(5);
    expect(me.last_engaged_at).toMatch(/Z$/);
  });

  it("ROOM-6: anonymous forwarded viewer is flagged", async () => {
    const m = await seedOrg();
    const room = await makeRoom(m.headers);
    await post(`/api/v1/rooms/${room.id}/publish`, m.headers);

    const r = await post("/api/v1/rooms/track", { "CF-Connecting-IP": "203.0.113.9" }, {
      slug: room.slug,
      type: "page_view",
      session_id: "anon1",
    });
    expect(r.status).toBe(204);

    const analytics = await json(await api(`/api/v1/rooms/${room.id}/analytics`, { headers: m.headers }));
    expect(analytics.recipients).toEqual([]);
    expect(analytics.anonymous_events).toBe(1);
    expect(analytics.anonymous_sessions).toBe(1);

    // The full IP is never persisted on room events.
    const ev = await env.DB.prepare("SELECT * FROM room_events WHERE room_id = ?").bind(room.id).first();
    expect(JSON.stringify(ev)).not.toContain("203.0.113.9");
  });

  it("ROOM-7: unknown event type and bad slug rejected", async () => {
    const m = await seedOrg();
    const room = await makeRoom(m.headers);
    await post(`/api/v1/rooms/${room.id}/publish`, m.headers);

    const badType = await post("/api/v1/rooms/track", {}, { slug: room.slug, type: "keystroke", session_id: "s" });
    expect(badType.status).toBe(400);
    expect((await json(badType)).detail).toBe("Unknown event type 'keystroke'.");

    const badSlug = await post("/api/v1/rooms/track", {}, { slug: "no-such-room", type: "page_view", session_id: "s" });
    expect(badSlug.status).toBe(404);
  });

  it("lists, updates and scopes rooms to the org", async () => {
    const m = await seedOrg();
    const room = await makeRoom(m.headers);
    const upd = await api(`/api/v1/rooms/${room.id}`, {
      method: "PATCH",
      headers: m.headers,
      json: { title: "Renamed", asset_ids: ["x"], personalization: { headline: "Hi {{contact_first_name}}" } },
    });
    expect(upd.status).toBe(200);
    expect(await json(upd)).toMatchObject({ title: "Renamed", asset_ids: ["x"], slug: room.slug });

    const list = await json(await api("/api/v1/rooms", { headers: m.headers }));
    expect(list.map((r: any) => r.id)).toEqual([room.id]);

    // Another org can't see it; bad ids are 400.
    const other = await member(newOrgId(), "member");
    expect((await api(`/api/v1/rooms/${room.id}`, { headers: other.headers })).status).toBe(404);
    expect((await api(`/api/v1/rooms/not-a-uuid`, { headers: m.headers })).status).toBe(400);
    expect(await json(await api("/api/v1/rooms", { headers: other.headers }))).toEqual([]);
  });
});
