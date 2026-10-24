/**
 * Public Beam State API (/api/pages). Ports backend/tests/test_beam_state.py.
 * Pages are seeded in D1 + R2 and served once through /p to mint the token
 * (exactly what the Python helper did). The owner-side halves of
 * test_owner_views_rotate_and_timeline (/api/v1/pages/{id}/...) belong to the
 * pages router; here the same effects are checked in D1, and token rotation
 * is applied as the row change it makes.
 */
import { describe, expect, it } from "vitest";
import { api, env } from "./helpers";
import { MAX_COMMENTS_PER_PAGE, MAX_KEYS_PER_PAGE } from "../src/services/pageState";
import { iso, newUser, rows, seedPage } from "./serveSeed";

const HTML = "<html><head><title>b</title></head><body>board</body></html>";

async function page() {
  const uid = await newUser();
  const p = await seedPage(uid, HTML);
  // Serve once: mints the state token and injects the helper.
  const served = await api(`/p/${p.slug}`);
  expect(served.status).toBe(200);
  const m = /window\.__BEAM__=\{page:"([^"]+)",token:"([^"]+)"/.exec(await served.text());
  expect(m).not.toBeNull();
  expect(m![1]).toBe(p.slug);
  return { ...p, slug: p.slug!, token: m![2] };
}

const tok = (token: string, extra: Record<string, string> = {}) => ({
  "X-Beam-Token": token,
  "Content-Type": "application/json",
  ...extra,
});
const send = (method: string, path: string, token: string, body?: unknown, extra: Record<string, string> = {}) =>
  api(path, { method, headers: tok(token, extra), body: body === undefined ? undefined : JSON.stringify(body) });

describe("Beam State API (test_beam_state.py)", () => {
  it("comments and state round trip", async () => {
    const { slug, shortCode, token, id } = await page();
    const c1 = await send("POST", `/api/pages/${slug}/comments`, token, { author: "Deep", body: "first" });
    expect(c1.status).toBe(201);
    const c1b = await c1.json<any>();
    expect(c1b.author).toBe("Deep");
    expect(c1b.ts).toMatch(/Z$/);
    const c2 = await (await send("POST", `/api/pages/${slug}/comments`, token, { author: "Rohan", body: "second" })).json<any>();
    const listed = await (await send("GET", `/api/pages/${slug}/comments`, token)).json<any>();
    expect(listed.comments.map((c: any) => c.body)).toEqual(["first", "second"]);
    const newer = await (await send("GET", `/api/pages/${slug}/comments?after=${c1b.id}`, token)).json<any>();
    expect(newer.comments.map((c: any) => c.body)).toEqual(["second"]);
    expect(newer.next_after).toBe(c2.id);
    const none = await (await send("GET", `/api/pages/${slug}/comments?after=${c2.id}`, token)).json<any>();
    expect(none).toEqual({ comments: [], next_after: c2.id });
    expect((await send("GET", `/api/pages/${slug}/comments?after=not-a-uuid`, token)).status).toBe(400);
    expect((await send("GET", `/api/pages/${slug}/comments?limit=0`, token)).status).toBe(422);

    const put = await send("PUT", `/api/pages/${slug}/state/check:1`, token, { done: true, by: "Sonali" });
    expect(put.status).toBe(200);
    expect((await put.json<any>()).value.done).toBe(true);
    const put2 = await send("PUT", `/api/pages/${slug}/state/check:1`, token, false); // LWW overwrite
    expect((await put2.json<any>()).value).toBe(false);
    const one = await (await send("GET", `/api/pages/${slug}/state/check:1`, token)).json<any>();
    expect(one.value).toBe(false);
    expect(one.key).toBe("check:1");
    const allst = await (await send("GET", `/api/pages/${slug}/state`, token)).json<any>();
    expect(allst.state).toEqual({ "check:1": false });
    expect(allst.updated_at).toMatch(/Z$/);
    const missing = await send("GET", `/api/pages/${slug}/state/nope`, token);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ detail: "Key not set." });
    expect((await send("DELETE", `/api/pages/${slug}/state/check:1`, token)).status).toBe(204);
    expect(await (await send("GET", `/api/pages/${slug}/state`, token)).json()).toEqual({ state: {}, updated_at: null });

    // short_code works as the ident too
    expect((await send("GET", `/api/pages/${shortCode}/state`, token)).status).toBe(200);

    // Timeline events recorded (owner /events view reads these).
    const evs = await rows("SELECT event_type, ref FROM page_events WHERE page_id = ?", id);
    expect(evs).toContainEqual({ event_type: "comment_added", ref: c1b.id });
    expect(evs.filter((e) => e.event_type === "state_changed").map((e) => e.ref)).toEqual(["check:1", "check:1", "check:1"]);
  });

  it("token scope and validation", async () => {
    const a = await page();
    const b = await page();
    expect((await api(`/api/pages/${a.slug}/state`)).status).toBe(401);
    expect((await send("GET", `/api/pages/${a.slug}/state`, "nope")).status).toBe(401);
    expect((await send("GET", `/api/pages/${a.slug}/state`, b.token)).status).toBe(401);
    expect((await api(`/api/pages/${a.slug}/state`, { headers: { Authorization: `Bearer ${a.token}` } })).status).toBe(200);
    expect((await send("GET", "/api/pages/no-such-page/state", a.token)).status).toBe(404);
    expect((await api(`https://nobody.example.com/api/pages/${a.slug}/state`, { headers: tok(a.token) })).status).toBe(404);

    const big = await send("POST", `/api/pages/${a.slug}/comments`, a.token, { author: "x", body: "y".repeat(4001) });
    expect(big.status).toBe(413);
    const tooBig = await send("POST", `/api/pages/${a.slug}/comments`, a.token, { author: "x", body: "y".repeat(4002) });
    expect(tooBig.status).toBe(422);
    const bigv = await send("PUT", `/api/pages/${a.slug}/state/k`, a.token, { blob: "z".repeat(16 * 1024 + 1) });
    expect(bigv.status).toBe(413);
    const badkey = await send("PUT", `/api/pages/${a.slug}/state/bad%20key!`, a.token, 1);
    expect(badkey.status).toBe(400);
    const noauthor = await send("POST", `/api/pages/${a.slug}/comments`, a.token, { author: " ", body: "hi" });
    expect(noauthor.status).toBe(400);
  });

  it("caps and rate limit", async () => {
    const { slug, id, token } = await page();
    // Fill the page to its caps directly (Python monkeypatched the constants).
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
       INSERT INTO page_state (id, page_id, key, value, updated_at) SELECT lower(hex(randomblob(16))), ?, 'k' || i, '1', ? FROM n`,
    )
      .bind(MAX_KEYS_PER_PAGE, id, iso())
      .run();
    expect((await send("PUT", `/api/pages/${slug}/state/c`, token, 1)).status).toBe(409);
    expect((await send("PUT", `/api/pages/${slug}/state/k1`, token, 2)).status).toBe(200); // overwrite ok

    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
       INSERT INTO page_comments (id, page_id, author, body, created_at) SELECT lower(hex(randomblob(16))), ?, 'a', 'b', ? FROM n`,
    )
      .bind(MAX_COMMENTS_PER_PAGE, id, iso())
      .run();
    const full = await send("POST", `/api/pages/${slug}/comments`, token, { author: "a", body: "2" });
    expect(full.status).toBe(409);
    expect(await full.json()).toEqual({ detail: "This page has reached its comment limit." });

    // Pre-load this IP's write window past 30/minute.
    const ip = "198.51.100.9";
    const window = Math.floor(Date.now() / 1000 / 60);
    await env.DB.prepare("INSERT INTO rate_counters (key, count, expires_at) VALUES (?, 30, ?)")
      .bind(`pgst_rl:${id}:${ip}:${window}`, Math.floor(Date.now() / 1000) + 60)
      .run();
    expect((await send("PUT", `/api/pages/${slug}/state/k1`, token, 3, { "CF-Connecting-IP": ip })).status).toBe(429);
  });

  it("kill switch freezes state", async () => {
    const { slug, id, token } = await page();
    expect((await send("PUT", `/api/pages/${slug}/state/x`, token, 1)).status).toBe(200);
    await env.DB.prepare("UPDATE file_assets SET revoked_at = ? WHERE id = ?").bind(iso(), id).run();
    for (const [method, path, body] of [
      ["GET", `/api/pages/${slug}/state`, undefined],
      ["PUT", `/api/pages/${slug}/state/x`, 2],
      ["GET", `/api/pages/${slug}/comments`, undefined],
      ["POST", `/api/pages/${slug}/comments`, { author: "a", body: "b" }],
    ] as const) {
      const r = await send(method, path, token, body);
      expect(r.status, `${method} ${path}`).toBe(410);
    }
  });

  it("owner views: stored rows, rotation invalidates the old token", async () => {
    const { slug, id, token } = await page();
    const c = await (await send("POST", `/api/pages/${slug}/comments`, token, { author: "Deep", body: "hello" })).json<any>();
    await send("PUT", `/api/pages/${slug}/state/tick`, token, true);

    expect(await rows("SELECT body FROM page_comments WHERE page_id = ?", id)).toEqual([{ body: "hello" }]);
    const st = await rows("SELECT key, value FROM page_state WHERE page_id = ?", id);
    expect(st.map((s) => [s.key, JSON.parse(s.value)])).toEqual([["tick", true]]);
    const tl = await rows("SELECT event_type, ref FROM page_events WHERE page_id = ?", id);
    expect(tl.find((x) => x.event_type === "comment_added")!.ref).toBe(c.id);
    expect(tl.find((x) => x.event_type === "state_changed")!.ref).toBe("tick");
    // One serve -> one view.
    expect(await rows("SELECT id FROM click_events WHERE file_id = ?", id)).toHaveLength(1);

    await env.DB.prepare("UPDATE file_assets SET state_token = 'rotated-token-value' WHERE id = ?").bind(id).run();
    expect((await send("GET", `/api/pages/${slug}/state`, token)).status).toBe(401);
    expect((await send("GET", `/api/pages/${slug}/state`, "rotated-token-value")).status).toBe(200);
  });
});
