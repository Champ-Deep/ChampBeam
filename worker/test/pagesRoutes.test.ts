/**
 * Route tests for /api/v1/pages. Ports the API-side behaviour of
 * backend/tests/test_beam_pages.py (publish JSON + multipart with rejections,
 * slug rules, list/get/delete + kill switch, versions rollback + prune, legacy
 * upload gets a slug, stored blob byte-identical, non-HTML not injected) plus
 * the owner Beam State / analytics endpoints.
 *
 * The public /p and /f serve routes belong to another router, so instead of
 * fetching them these tests assert on D1 rows and the bytes stored in R2.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api, authedUser, env, json, sha256Hex } from "./helpers";
import { getSettings, type Env, type Settings } from "../src/env";

const HTML =
  "<!doctype html><html><head><title>T</title></head><body><p>hello</p><script>localStorage.x=1</script></body></html>";

const patched: [Settings, Partial<Settings>][] = [];
function setSettings(patch: Partial<Settings>) {
  const s = getSettings(env as unknown as Env);
  const saved: Partial<Settings> = {};
  for (const k of Object.keys(patch) as (keyof Settings)[]) (saved as any)[k] = s[k];
  patched.push([s, saved]);
  Object.assign(s, patch);
}
// Python ran each test on a fresh database; slugs are global per namespace,
// so clear pages between tests here.
beforeEach(async () => {
  await env.DB.batch(
    ["page_engagements", "click_events", "page_comments", "page_state", "page_events", "file_versions", "access_leads", "file_assets"].map(
      (t) => env.DB.prepare(`DELETE FROM ${t}`),
    ),
  );
});
afterEach(() => {
  while (patched.length) {
    const [s, saved] = patched.pop()!;
    Object.assign(s, saved);
  }
});

async function publish(headers: Record<string, string>, body: Record<string, unknown> = {}) {
  const r = await api("/api/v1/pages", { method: "POST", json: { html: HTML, title: "Pallab North Star", ...body }, headers });
  expect(r.status, await r.clone().text()).toBe(201);
  return json(r);
}

async function row(id: string) {
  return (await env.DB.prepare("SELECT * FROM file_assets WHERE id = ?").bind(id).first<Record<string, any>>())!;
}

async function blob(key: string): Promise<string | null> {
  const o = await env.FILES.get(key);
  return o ? o.text() : null;
}

async function keysUnder(prefix: string): Promise<string[]> {
  return (await env.FILES.list({ prefix })).objects.map((o) => o.key);
}

async function eventually(check: () => Promise<boolean>, tries = 50): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

/** The bytes the page currently serves (its live R2 blob). */
async function live(pageId: string): Promise<string | null> {
  return blob((await row(pageId)).storage_key);
}

describe("publish", () => {
  it("publishes on a slug with a legacy code URL (test_publish_serves_on_slug_and_legacy_code)", async () => {
    const { headers, user } = await authedUser();
    const page = await publish(headers);
    expect(page.slug).toBe("pallab-north-star");
    expect(page.url).toBe("https://share.example.com/p/pallab-north-star");
    expect(page.legacy_url).toBe(`https://share.example.com/f/${page.short_code}`);
    expect(page.current_version).toBe(1);
    expect(page).toMatchObject({
      title: "pallab north star",
      size_bytes: HTML.length,
      view_count: 0,
      unique_visitors: 0,
      revisits: 0,
      total_dwell_ms: 0,
      enabled: true,
      has_access_code: false,
      domain_id: null,
    });
    expect(page.created_at).toMatch(/Z$/);
    expect(page.updated_at).toMatch(/Z$/);

    const r = await row(page.page_id);
    expect(r).toMatchObject({
      user_id: user.id,
      kind: "html",
      mime_type: "text/html",
      status: "active",
      serve_mode: "stream",
      slug: "pallab-north-star",
      filename: "pallab-north-star.html",
      sha256: await sha256Hex(HTML),
    });
    expect(r.storage_key).toBe(`u/${user.id}/${page.page_id}/pallab-north-star.html`);
    const versions = await env.DB.prepare("SELECT version_no, storage_key FROM file_versions WHERE file_id = ?").bind(page.page_id).all();
    expect(versions.results).toEqual([{ version_no: 1, storage_key: r.storage_key }]);
  });

  it("stores the blob byte-identical (test_stored_blob_is_byte_identical)", async () => {
    const { headers, user } = await authedUser();
    const page = await publish(headers);
    const keys = await keysUnder(`u/${user.id}/`);
    expect(keys).toHaveLength(1);
    const obj = await env.FILES.get(keys[0]);
    expect(new Uint8Array(await obj!.arrayBuffer())).toEqual(new TextEncoder().encode(HTML));
    expect(keys[0]).toBe((await row(page.page_id)).storage_key);
  });

  it("multipart upload and rejections (test_multipart_upload_and_rejections)", async () => {
    const { headers } = await authedUser();
    const form = new FormData();
    form.append("file", new File([HTML], "board.html", { type: "text/html" }));
    form.append("title", "APAC Handover");
    const ok = await api("/api/v1/pages/upload", { method: "POST", body: form, headers });
    expect(ok.status, await ok.clone().text()).toBe(201);
    const okBody = await json(ok);
    expect(okBody.slug).toBe("apac-handover");
    expect(await live(okBody.page_id)).toBe(HTML);

    // Title falls back to the filename.
    const f2 = new FormData();
    f2.append("file", new File([HTML], "q3-board-pack.html", { type: "text/html" }));
    const noTitle = await json(await api("/api/v1/pages/upload", { method: "POST", body: f2, headers }));
    expect(noTitle.slug).toBe("q3-board-pack");
    expect(noTitle.title).toBe("q3 board pack");

    const upload = (name: string, body: string, type: string) => {
      const f = new FormData();
      f.append("file", new File([body], name, { type }));
      return api("/api/v1/pages/upload", { method: "POST", body: f, headers });
    };
    const badExt = await upload("x.php", "<html>", "text/html");
    expect(badExt.status).toBe(400);
    expect((await json(badExt)).detail).toContain("server-side");

    expect((await upload("x.html", "<html>", "text/plain")).status).toBe(400);

    const missing = await api("/api/v1/pages/upload", { method: "POST", body: new FormData(), headers });
    expect(missing.status).toBe(422);

    const php = await api("/api/v1/pages", { method: "POST", json: { html: "<html><?php echo 1; ?></html>", title: "x" }, headers });
    expect(php.status).toBe(400);
    expect((await json(php)).detail).toContain("server-side");

    const asp = await api("/api/v1/pages", { method: "POST", json: { html: "<html><% x %></html>", title: "x" }, headers });
    expect(asp.status).toBe(400);

    expect((await api("/api/v1/pages", { method: "POST", json: { html: "", title: "x" }, headers })).status).toBe(422);
    const blank = await api("/api/v1/pages", { method: "POST", json: { html: "   \n", title: "x" }, headers });
    expect(blank.status).toBe(400);
    expect(await json(blank)).toEqual({ detail: "The page is empty." });

    setSettings({ pagesMaxBytes: 64 });
    const big = await api("/api/v1/pages", { method: "POST", json: { html: "<html>" + "a".repeat(100) + "</html>", title: "big" }, headers });
    expect(big.status).toBe(413);
    expect((await upload("big.html", "<html>" + "a".repeat(100) + "</html>", "text/html")).status).toBe(413);
  });

  it("requires auth", async () => {
    expect((await api("/api/v1/pages", { method: "POST", json: { html: HTML } })).status).toBe(401);
    expect((await api("/api/v1/pages")).status).toBe(401);
  });

  it("rejects a domain that is not the caller's", async () => {
    const { headers } = await authedUser();
    const r = await api("/api/v1/pages", { method: "POST", json: { html: HTML, domain_id: crypto.randomUUID() }, headers });
    expect(r.status).toBe(400);
    expect(await json(r)).toEqual({ detail: "Domain not found, not yours, or not active." });
  });

  it("serves from the user's active custom domain in URLs", async () => {
    const { headers, user } = await authedUser();
    const domainId = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO domains (id, user_id, hostname, status, is_primary, created_at) VALUES (?,?,?,?,0,?)")
      .bind(domainId, user.id, "links.example.com", "active", new Date().toISOString())
      .run();
    const page = await publish(headers, { domain_id: domainId, slug: "on-my-domain" });
    expect(page.domain_id).toBe(domainId);
    expect(page.url).toBe("https://links.example.com/p/on-my-domain");
  });
});

describe("slugs (test_slug_rules)", () => {
  it("validates, dedupes and moves slugs", async () => {
    const { headers } = await authedUser();
    for (const bad of ["ab", "Bad Slug", "-lead", "api", "trail-"]) {
      const r = await api("/api/v1/pages", { method: "POST", json: { html: HTML, title: "t", slug: bad }, headers });
      expect(r.status, bad).toBe(400);
    }
    const first = await publish(headers, { slug: "weekly-plan" });
    const dup = await api("/api/v1/pages", { method: "POST", json: { html: HTML, title: "t", slug: "weekly-plan" }, headers });
    expect(dup.status).toBe(409);
    expect(await json(dup)).toEqual({ detail: "That slug is already taken." });

    const second = await publish(headers, { title: "Other" });
    expect(second.slug).toBe("other");
    const taken = await api(`/api/v1/pages/${second.page_id}`, { method: "PATCH", json: { slug: "weekly-plan" }, headers });
    expect(taken.status).toBe(409);
    const moved = await api(`/api/v1/pages/${first.page_id}`, { method: "PATCH", json: { slug: "weekly-plan-v2" }, headers });
    expect(moved.status).toBe(200);
    expect((await json(moved)).url.endsWith("/p/weekly-plan-v2")).toBe(true);
    expect((await row(first.page_id)).slug).toBe("weekly-plan-v2");
    // The retired slug stays reserved (it still resolves to the moved page) and cannot be reissued.
    const reuse = await api("/api/v1/pages", { method: "POST", json: { html: HTML, slug: "weekly-plan" }, headers });
    expect(reuse.status).toBe(409);
    // A title-derived duplicate is numbered deterministically.
    const again = await publish(headers, { title: "Other" });
    expect(again.slug).toBe("other-2");
  });
});

describe("list / get / delete / kill switch (test_list_get_delete_and_kill_switch)", () => {
  it("works end to end", async () => {
    const { headers, user } = await authedUser();
    const page = await publish(headers);
    const pid = page.page_id;

    const listed = await json(await api("/api/v1/pages", { headers }));
    expect(listed.map((p: any) => p.page_id)).toEqual([pid]);
    expect((await api(`/api/v1/pages/${pid}`, { headers })).status).toBe(200);
    expect((await api(`/api/v1/pages/nope`, { headers })).status).toBe(400);
    expect((await api(`/api/v1/pages/${crypto.randomUUID()}`, { headers })).status).toBe(404);
    const other = await authedUser();
    expect((await api(`/api/v1/pages/${pid}`, { headers: other.headers })).status).toBe(404);

    const off = await api(`/api/v1/pages/${pid}`, { method: "PATCH", json: { enabled: false }, headers });
    expect(off.status).toBe(200);
    expect((await json(off)).enabled).toBe(false);
    expect((await row(pid)).revoked_at).toBeTruthy();

    const on = await api(`/api/v1/pages/${pid}`, { method: "PATCH", json: { enabled: true }, headers });
    expect((await json(on)).enabled).toBe(true);
    expect((await row(pid)).revoked_at).toBeNull();

    // A content update so two version blobs exist before deletion.
    await api(`/api/v1/pages/${pid}`, { method: "PUT", json: { html: "<html><body>v2</body></html>" }, headers });
    expect(await keysUnder(`u/${user.id}/${pid}/`)).toHaveLength(2);

    expect((await api(`/api/v1/pages/${pid}`, { method: "DELETE", headers })).status).toBe(204);
    expect((await row(pid)).status).toBe("deleted");
    const vcount = await env.DB.prepare("SELECT count(*) AS n FROM file_versions WHERE file_id = ?").bind(pid).first<{ n: number }>();
    expect(vcount!.n).toBe(0);
    expect((await api(`/api/v1/pages/${pid}`, { headers })).status).toBe(404);
    expect(await json(await api("/api/v1/pages", { headers }))).toEqual([]);
    expect(await eventually(async () => (await keysUnder(`u/${user.id}/`)).length === 0)).toBe(true);
  });

  it("patch title and access code", async () => {
    const { headers } = await authedUser();
    const page = await publish(headers);
    const t = await json(await api(`/api/v1/pages/${page.page_id}`, { method: "PATCH", json: { title: "New Name" }, headers }));
    expect(t.title).toBe("new name");
    expect(t.slug).toBe("pallab-north-star");
    const code = await json(await api(`/api/v1/pages/${page.page_id}`, { method: "PATCH", json: { access_code: "1234" }, headers }));
    expect(code.has_access_code).toBe(true);
    expect((await row(page.page_id)).access_code_hash).toMatch(/^[0-9a-f]{64}$/);
    const bad = await api(`/api/v1/pages/${page.page_id}`, { method: "PATCH", json: { access_code: "12ab" }, headers });
    expect(bad.status).toBe(422);
    const cleared = await json(await api(`/api/v1/pages/${page.page_id}`, { method: "PATCH", json: { access_code: null }, headers }));
    expect(cleared.has_access_code).toBe(false);
  });
});

describe("versions (test_versions_rollback_and_prune)", () => {
  it("updates, rolls back and prunes", async () => {
    const { headers, user } = await authedUser();
    const page = await publish(headers);
    const pid = page.page_id;

    for (const n of [2, 3, 4]) {
      const r = await api(`/api/v1/pages/${pid}`, { method: "PUT", json: { html: `<html><head></head><body>v${n}</body></html>` }, headers });
      expect(r.status).toBe(200);
      const b = await json(r);
      expect(b.current_version).toBe(n);
      expect(b.url).toBe(page.url);
      expect(b.short_code).toBe(page.short_code);
    }

    let versions = await json(await api(`/api/v1/pages/${pid}/versions`, { headers }));
    expect(versions.map((v: any) => v.version_no)).toEqual([4, 3, 2, 1]);
    expect(versions.map((v: any) => v.current)).toEqual([true, false, false, false]);
    expect(await live(pid)).toContain("v4");

    const rb = await api(`/api/v1/pages/${pid}/versions/1/rollback`, { method: "POST", headers });
    expect(rb.status).toBe(200);
    expect((await json(rb)).current_version).toBe(5);
    const served = await live(pid);
    expect(served).toBe(HTML);

    // Rolling back to the current version is a no-op; unknown version 404; bad int 422.
    expect((await json(await api(`/api/v1/pages/${pid}/versions/5/rollback`, { method: "POST", headers }))).current_version).toBe(5);
    const nf = await api(`/api/v1/pages/${pid}/versions/99/rollback`, { method: "POST", headers });
    expect(nf.status).toBe(404);
    expect(await json(nf)).toEqual({ detail: "Version not found." });
    expect((await api(`/api/v1/pages/${pid}/versions/x/rollback`, { method: "POST", headers })).status).toBe(422);

    setSettings({ pagesVersionsKeep: 2 });
    await api(`/api/v1/pages/${pid}`, { method: "PUT", json: { html: "<html><head></head><body>v6</body></html>" }, headers });
    versions = await json(await api(`/api/v1/pages/${pid}/versions`, { headers }));
    expect(versions.map((v: any) => v.version_no)).toEqual([6, 5]);
    expect(await eventually(async () => (await keysUnder(`u/${user.id}/${pid}/`)).length === 2)).toBe(true);
  });

  it("legacy upload gets a slug and keeps the original rollback-able", async () => {
    const { headers } = await authedUser();
    const page = await publish(headers);
    const pid = page.page_id;
    // Turn it into a pre-Beam-Pages upload.
    await env.DB.batch([
      env.DB.prepare("DELETE FROM file_versions WHERE file_id = ?").bind(pid),
      env.DB.prepare("UPDATE file_assets SET slug = NULL WHERE id = ?").bind(pid),
    ]);

    const listed = (await json(await api("/api/v1/pages", { headers })))[0];
    expect(listed.slug).toBe("pallab-north-star");
    expect(listed.url.endsWith("/p/pallab-north-star")).toBe(true);
    expect(listed.current_version).toBe(0);
    expect((await row(pid)).slug).toBe("pallab-north-star");

    const r = await api(`/api/v1/pages/${pid}`, { method: "PUT", json: { html: "<html><head></head><body>v2</body></html>" }, headers });
    expect(r.status).toBe(200);
    expect((await json(r)).current_version).toBe(2);
    const versions = await json(await api(`/api/v1/pages/${pid}/versions`, { headers }));
    expect(versions.map((v: any) => v.version_no)).toEqual([2, 1]);

    const rb = await api(`/api/v1/pages/${pid}/versions/1/rollback`, { method: "POST", headers });
    expect(rb.status).toBe(200);
    expect((await json(rb)).current_version).toBe(3);
    const served = await live(pid);
    expect(served).toContain("hello");
    expect(served).not.toContain("v2");
  });
});

describe("non-HTML file is not injected (test_non_html_file_is_not_injected)", () => {
  it("stores a plain upload verbatim and keeps it out of the pages list", async () => {
    const { headers } = await authedUser();
    const content = "just text";
    const init = await json(
      await api("/api/v1/files", { method: "POST", json: { filename: "a.txt", content_type: "text/plain", size_bytes: content.length }, headers }),
    );
    expect((await api(init.presigned_put_url, { method: "PUT", body: new TextEncoder().encode(content), headers: { "Content-Type": "text/plain" } })).status).toBe(204);
    expect((await api(`/api/v1/files/${init.file_id}/finalize`, { method: "POST", json: {}, headers })).status).toBe(200);
    expect(await live(init.file_id)).toBe(content);
    expect((await row(init.file_id)).kind).toBe("other");
    expect(await json(await api("/api/v1/pages", { headers }))).toEqual([]);
    expect((await api(`/api/v1/pages/${init.file_id}`, { headers })).status).toBe(404);
  });
});

describe("analytics, Beam State admin, timeline", () => {
  it("reports views, revisits and dwell", async () => {
    const { headers } = await authedUser();
    const page = await publish(headers);
    const pid = page.page_id;
    const now = Date.now();
    const view = (vid: string, ip: string, revisit: number, ageMs: number) =>
      env.DB.prepare("INSERT INTO click_events (id, file_id, visitor_id, ip_address, is_revisit, is_vpn, clicked_at) VALUES (?,?,?,?,?,0,?)")
        .bind(crypto.randomUUID(), pid, vid, ip, revisit, new Date(now - ageMs).toISOString());
    const dwell = (sid: string, ms: number) =>
      env.DB.prepare("INSERT INTO page_engagements (id, file_id, session_id, page, dwell_ms, created_at) VALUES (?,?,?,0,?,?)")
        .bind(crypto.randomUUID(), pid, sid, ms, new Date().toISOString());
    await env.DB.batch([
      view("vid-aaaaaaaa", "1.1.1.1", 0, 4000),
      view("vid-aaaaaaaa", "1.1.1.1", 0, 3000),
      view("vid-aaaaaaaa", "1.1.1.1", 1, 2000),
      view("vid-bbbbbbbb", "2.2.2.2", 0, 1000),
      dwell("s1", 12000),
      dwell("s2", 4000),
      dwell("s1", 60000),
    ]);

    const a = await json(await api(`/api/v1/pages/${pid}/analytics`, { headers }));
    expect(a).toMatchObject({
      page_id: pid,
      slug: "pallab-north-star",
      short_code: page.short_code,
      title: "pallab north star",
      views: 4,
      unique_visitors: 2,
      revisits: 1,
      sessions: 2,
      total_dwell_ms: 76000,
      median_dwell_ms: Math.trunc((72000 + 4000) / 2),
      avg_dwell_ms: 38000,
    });
    const listed = (await json(await api("/api/v1/pages", { headers })))[0];
    expect(listed).toMatchObject({ unique_visitors: 2, revisits: 1, total_dwell_ms: 76000 });

    await env.DB.prepare("INSERT INTO page_events (id, page_id, event_type, ref, visitor_id, ip, created_at) VALUES (?,?,?,?,?,?,?)")
      .bind(crypto.randomUUID(), pid, "comment_added", "c1", "vid-bbbbbbbb", "2.2.2.2", new Date(now - 500).toISOString())
      .run();
    const timeline = await json(await api(`/api/v1/pages/${pid}/events`, { headers }));
    expect(timeline.map((e: any) => e.type)).toEqual(["comment_added", "view", "revisit", "view", "view"]);
    expect(timeline[0]).toMatchObject({ ref: "c1", country: null, is_vpn: false });
    expect(Object.keys(timeline[1]).sort()).toEqual(
      ["browser", "city", "country", "device_type", "ip", "is_vpn", "os", "ref", "ts", "type", "visitor_id"].sort(),
    );
    expect(await json(await api(`/api/v1/pages/${pid}/events?limit=2`, { headers }))).toHaveLength(2);
  });

  it("owner comments/state moderation and token rotation", async () => {
    const { headers } = await authedUser();
    const page = await publish(headers);
    const pid = page.page_id;
    const cid = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO page_comments (id, page_id, author, body, visitor_id, ip, created_at) VALUES (?,?,?,?,?,?,?)")
        .bind(cid, pid, "Ann", "Hi", "vid-1", "1.1.1.1", new Date().toISOString()),
      env.DB.prepare("INSERT INTO page_state (id, page_id, key, value, updated_at) VALUES (?,?,?,?,?)")
        .bind(crypto.randomUUID(), pid, "b", JSON.stringify({ x: 1 }), new Date().toISOString()),
      env.DB.prepare("INSERT INTO page_state (id, page_id, key, value, updated_at) VALUES (?,?,?,?,?)")
        .bind(crypto.randomUUID(), pid, "a", JSON.stringify([1, 2]), new Date().toISOString()),
    ]);

    const comments = await json(await api(`/api/v1/pages/${pid}/comments`, { headers }));
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ id: cid, author: "Ann", body: "Hi", visitor_id: "vid-1", ip: "1.1.1.1" });
    expect((await api(`/api/v1/pages/${pid}/comments/bad`, { method: "DELETE", headers })).status).toBe(400);
    expect((await api(`/api/v1/pages/${pid}/comments/${crypto.randomUUID()}`, { method: "DELETE", headers })).status).toBe(404);
    expect((await api(`/api/v1/pages/${pid}/comments/${cid}`, { method: "DELETE", headers })).status).toBe(204);
    expect(await json(await api(`/api/v1/pages/${pid}/comments`, { headers }))).toEqual([]);

    const state = await json(await api(`/api/v1/pages/${pid}/state`, { headers }));
    expect(state).toEqual({ state: { a: [1, 2], b: { x: 1 } }, count: 2 });
    expect(Object.keys(state.state)).toEqual(["a", "b"]);
    expect((await api(`/api/v1/pages/${pid}/state/a`, { method: "DELETE", headers })).status).toBe(204);
    expect((await api(`/api/v1/pages/${pid}/state/missing`, { method: "DELETE", headers })).status).toBe(204);
    expect((await json(await api(`/api/v1/pages/${pid}/state`, { headers }))).count).toBe(1);
    expect((await api(`/api/v1/pages/${pid}/state`, { method: "DELETE", headers })).status).toBe(204);
    expect(await json(await api(`/api/v1/pages/${pid}/state`, { headers }))).toEqual({ state: {}, count: 0 });

    const t1 = await json(await api(`/api/v1/pages/${pid}/state-token/rotate`, { method: "POST", headers }));
    const t2 = await json(await api(`/api/v1/pages/${pid}/state-token/rotate`, { method: "POST", headers }));
    expect(typeof t1.state_token).toBe("string");
    expect(t1.state_token).not.toBe(t2.state_token);
    expect((await row(pid)).state_token).toBe(t2.state_token);
  });
});
