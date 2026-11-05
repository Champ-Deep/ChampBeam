/**
 * Route tests for /api/v1/files. Ports backend/tests/test_file_replace.py and
 * covers the upload flow (intent -> PUT blob -> finalize -> status), quotas,
 * blob-token checks, guest uploads, management and per-file analytics.
 *
 * Assertions are on API responses plus D1/R2 state; the public /f serve
 * routes are owned by another router and not exercised here.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, authedUser, env, json, sha256Hex } from "./helpers";
import { getSettings, type Env, type Settings } from "../src/env";
import { makeBlobToken } from "../src/lib/storage";

const patched: [Settings, Partial<Settings>][] = [];
function setSettings(patch: Partial<Settings>) {
  const s = getSettings(env as unknown as Env);
  const saved: Partial<Settings> = {};
  for (const k of Object.keys(patch) as (keyof Settings)[]) (saved as any)[k] = s[k];
  patched.push([s, saved]);
  Object.assign(s, patch);
}
afterEach(() => {
  while (patched.length) {
    const [s, saved] = patched.pop()!;
    Object.assign(s, saved);
  }
  vi.restoreAllMocks();
});

const enc = (s: string) => new TextEncoder().encode(s);

async function fileRow(id: string) {
  return env.DB.prepare("SELECT * FROM file_assets WHERE id = ?").bind(id).first<Record<string, any>>();
}

async function blobText(key: string): Promise<string | null> {
  const obj = await env.FILES.get(key);
  return obj ? obj.text() : null;
}

/** Background tasks (waitUntil) finish shortly after the response. */
async function eventually(check: () => Promise<boolean>, tries = 50): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

async function intent(headers: Record<string, string>, body: Record<string, unknown>) {
  return api("/api/v1/files", { method: "POST", json: body, headers });
}

/** intent -> PUT blob -> finalize; returns the init + finalize bodies. */
async function uploadFile(headers: Record<string, string>, content: string, filename = "a.txt", contentType = "text/plain") {
  const init = await intent(headers, { filename, content_type: contentType, size_bytes: enc(content).length });
  expect(init.status, await init.clone().text()).toBe(201);
  const d = await json(init);
  const put = await api(d.presigned_put_url, { method: "PUT", body: enc(content), headers: { "Content-Type": contentType } });
  expect(put.status).toBe(204);
  const fin = await api(`/api/v1/files/${d.file_id}/finalize`, { method: "POST", json: {}, headers });
  expect(fin.status).toBe(200);
  return { init: d, file: await json(fin) };
}

describe("upload flow", () => {
  it("intent -> PUT blob with token -> finalize -> status", async () => {
    const { headers, user } = await authedUser();
    const content = "%PDF-1.4 fake pdf bytes";
    const init = await intent(headers, { filename: "Deck Q3.pdf", content_type: "application/pdf", size_bytes: content.length });
    expect(init.status).toBe(201);
    const d = await json(init);
    expect(d.upload_via_backend).toBe(true);
    expect(d.presigned_put_url).toMatch(new RegExp(`^/api/v1/files/${d.file_id}/blob\\?token=\\d+\\.[0-9a-f]{64}$`));
    expect(d.headers).toEqual({ "Content-Type": "application/pdf" });
    expect(d.serve_mode).toBe("stream");
    expect(d.owner_token).toBeNull();
    expect(d.expires_at).toBeNull();
    expect(d.short_code).toMatch(/^[A-Za-z0-9]{8}$/);

    const row = await fileRow(d.file_id);
    expect(row!.status).toBe("pending_upload");
    expect(row!.storage_key).toBe(`u/${user.id}/${d.file_id}/Deck_Q3.pdf`);
    expect(row!.kind).toBe("pdf");

    const put = await api(d.presigned_put_url, { method: "PUT", body: enc(content), headers: { "Content-Type": "application/pdf" } });
    expect(put.status).toBe(204);
    expect(await blobText(row!.storage_key)).toBe(content);

    const fin = await api(`/api/v1/files/${d.file_id}/finalize`, { method: "POST", json: {}, headers });
    expect(fin.status).toBe(200);
    const f = await json(fin);
    expect(f).toMatchObject({
      id: d.file_id,
      short_code: d.short_code,
      filename: "Deck Q3.pdf",
      kind: "pdf",
      mime_type: "application/pdf",
      size_bytes: content.length,
      status: "active",
      serve_mode: "stream",
      view_count: 0,
      last_viewed_at: null,
      serve_url: `https://share.example.com/f/${d.short_code}/Deck_Q3.pdf`,
      domain_id: null,
      expires_at: null,
      project_id: null,
      max_views: null,
      remaining_views: null,
      require_email: false,
      block_vpn: false,
      branded: false,
      revoked: false,
      access_status: "tracking",
    });
    expect(f.created_at).toMatch(/Z$/);

    // sha256 is computed in the background.
    const expected = await sha256Hex(content);
    expect(await eventually(async () => (await fileRow(d.file_id))!.sha256 === expected)).toBe(true);

    // Re-finalize is idempotent.
    expect((await api(`/api/v1/files/${d.file_id}/finalize`, { method: "POST", headers })).status).toBe(200);
    // The blob endpoint refuses once finalized.
    const again = await api(d.presigned_put_url, { method: "PUT", body: enc(content) });
    expect(again.status).toBe(409);
    expect(await json(again)).toEqual({ detail: "This upload was already finalized." });

    const status = await api(`/api/v1/files/${d.file_id}/status`, { headers });
    expect(status.status).toBe(200);
    expect(await json(status)).toEqual({ view_count: 0, last_viewed_at: null, expires_at: null, status: "active", seen: false });

    const list = await json(await api("/api/v1/files", { headers }));
    expect(list.map((x: any) => x.id)).toEqual([d.file_id]);
  });

  it("with R2 S3 credentials the browser uploads straight to R2 (presigned)", async () => {
    const { headers } = await authedUser();
    setSettings({ r2PresignConfigured: true, r2AccountId: "acct", r2AccessKeyId: "AKID", r2SecretAccessKey: "secret", r2BucketName: "bkt" });
    const r = await intent(headers, { filename: "clip.mp4", content_type: "video/mp4", size_bytes: 200 * 1024 * 1024 });
    expect(r.status).toBe(201);
    const d = await json(r);
    expect(d.upload_via_backend).toBe(false);
    expect(d.serve_mode).toBe("redirect");
    expect(d.presigned_put_url).toMatch(/^https:\/\/acct\.r2\.cloudflarestorage\.com\/bkt\/u\/.+X-Amz-Signature=/);
    // The Worker-proxied blob endpoint does not exist in this mode.
    const blob = await api(`/api/v1/files/${d.file_id}/blob?token=x`, { method: "PUT", body: enc("x") });
    expect(blob.status).toBe(404);
  });

  it("quota exceeded is 402", async () => {
    const { headers } = await authedUser();
    setSettings({ maxBytesPerUser: 2 * 1024 * 1024 });
    const ok = await intent(headers, { filename: "a.pdf", content_type: "application/pdf", size_bytes: 1024 * 1024 });
    expect(ok.status).toBe(201);
    const over = await intent(headers, { filename: "b.pdf", content_type: "application/pdf", size_bytes: 1024 * 1024 + 1 });
    expect(over.status).toBe(402);
    expect(await json(over)).toEqual({ detail: "Storage quota exceeded (1 MB used of 2 MB)." });
  });

  it("per-kind caps are 413 and bad bodies 422", async () => {
    const { headers } = await authedUser();
    const r = await intent(headers, { filename: "a.png", content_type: "image/png", size_bytes: 10 * 1024 * 1024 + 1 });
    expect(r.status).toBe(413);
    expect(await json(r)).toEqual({ detail: "IMAGE uploads are capped at 10 MB." });
    expect((await intent(headers, { filename: "", content_type: "x", size_bytes: 1 })).status).toBe(422);
    expect((await intent(headers, { filename: "a", content_type: "x", size_bytes: 0 })).status).toBe(422);
  });

  it("worker-proxied uploads honour workerUploadMaxBytes", async () => {
    const { headers } = await authedUser();
    setSettings({ workerUploadMaxBytes: 1024 });
    const r = await intent(headers, { filename: "a.pdf", content_type: "application/pdf", size_bytes: 2048 });
    expect(r.status).toBe(413);
  });

  it("custom domain must be the caller's active domain", async () => {
    const { headers } = await authedUser();
    expect(await json(await intent(headers, { filename: "a.pdf", content_type: "application/pdf", size_bytes: 1, domain_id: "nope" }))).toEqual({
      detail: "Invalid domain_id.",
    });
    const r = await intent(headers, { filename: "a.pdf", content_type: "application/pdf", size_bytes: 1, domain_id: crypto.randomUUID() });
    expect(r.status).toBe(400);
    expect(await json(r)).toEqual({ detail: "Domain not found, not yours, or not active." });
  });

  it("blob token: missing 422, bad/expired/other-file 403", async () => {
    const { headers } = await authedUser();
    const d = await json(await intent(headers, { filename: "a.txt", content_type: "text/plain", size_bytes: 5 }));
    const base = `/api/v1/files/${d.file_id}/blob`;

    expect((await api(base, { method: "PUT", body: enc("hello") })).status).toBe(422);

    const bad = await api(`${base}?token=123.abc`, { method: "PUT", body: enc("hello") });
    expect(bad.status).toBe(403);
    expect(await json(bad)).toEqual({ detail: "Invalid or expired upload token." });

    const settings = getSettings(env as unknown as Env);
    const expired = await makeBlobToken(settings, d.file_id, -10);
    expect((await api(`${base}?token=${expired}`, { method: "PUT", body: enc("hello") })).status).toBe(403);

    const other = await makeBlobToken(settings, crypto.randomUUID());
    expect((await api(`${base}?token=${other}`, { method: "PUT", body: enc("hello") })).status).toBe(403);

    const badId = await api(`/api/v1/files/not-a-uuid/blob?token=x`, { method: "PUT", body: enc("hello") });
    expect(badId.status).toBe(400);
    expect(await json(badId)).toEqual({ detail: "Invalid file_id." });

    // Nothing was written.
    expect(await env.FILES.get((await fileRow(d.file_id))!.storage_key)).toBeNull();
  });

  it("a body larger than declared is 413 and marks the upload failed", async () => {
    const { headers } = await authedUser();
    const d = await json(await intent(headers, { filename: "a.txt", content_type: "text/plain", size_bytes: 3 }));
    const r = await api(d.presigned_put_url, { method: "PUT", body: enc("too long") });
    expect(r.status).toBe(413);
    expect(await json(r)).toEqual({ detail: "Upload exceeds the declared size." });
    expect((await fileRow(d.file_id))!.status).toBe("failed");
  });

  it("finalize without bytes is 400 (failed); size mismatch is 400", async () => {
    const { headers } = await authedUser();
    const d = await json(await intent(headers, { filename: "a.txt", content_type: "text/plain", size_bytes: 5 }));
    const r = await api(`/api/v1/files/${d.file_id}/finalize`, { method: "POST", json: {}, headers });
    expect(r.status).toBe(400);
    expect((await json(r)).detail).toMatch(/^Upload not found in storage\. The PUT may have failed: /);
    expect((await fileRow(d.file_id))!.status).toBe("failed");

    const d2 = await json(await intent(headers, { filename: "b.txt", content_type: "text/plain", size_bytes: 5 }));
    await env.FILES.put((await fileRow(d2.file_id))!.storage_key, "abc");
    const m = await api(`/api/v1/files/${d2.file_id}/finalize`, { method: "POST", headers });
    expect(m.status).toBe(400);
    expect(await json(m)).toEqual({ detail: "Uploaded size (3 B) does not match the declared size (5 B)." });

    // Another user can't finalize it.
    const other = await authedUser();
    expect((await api(`/api/v1/files/${d2.file_id}/finalize`, { method: "POST", headers: other.headers })).status).toBe(404);
    expect((await api(`/api/v1/files/xyz/finalize`, { method: "POST", headers })).status).toBe(400);
  });

  it("anonymous upload gets an owner token, expiry and guest caps", async () => {
    const tooBig = await intent({}, { filename: "a.pdf", content_type: "application/pdf", size_bytes: 10 * 1024 * 1024 + 1 });
    expect(tooBig.status).toBe(413);
    expect(await json(tooBig)).toEqual({ detail: "PDF uploads are capped at 10 MB." });
    const dom = await intent({}, { filename: "a.pdf", content_type: "application/pdf", size_bytes: 1, domain_id: crypto.randomUUID() });
    expect(dom.status).toBe(400);
    expect(await json(dom)).toEqual({ detail: "Custom domains require an account." });

    const content = "guest bytes";
    const init = await intent({}, { filename: "g.txt", content_type: "text/plain", size_bytes: content.length });
    expect(init.status).toBe(201);
    const d = await json(init);
    expect(typeof d.owner_token).toBe("string");
    expect(d.owner_token.length).toBeGreaterThan(30);
    const expiresMs = Date.parse(d.expires_at);
    expect(Math.abs(expiresMs - (Date.now() + 24 * 3600 * 1000))).toBeLessThan(60_000);
    const row = await fileRow(d.file_id);
    expect(row!.user_id).toBeNull();
    expect(row!.owner_token_hash).toBe(await sha256Hex(d.owner_token));
    expect(row!.storage_key).toBe(`anon/${d.file_id}/g.txt`);

    expect((await api(d.presigned_put_url, { method: "PUT", body: enc(content) })).status).toBe(204);

    // Without (or with a wrong) owner token the guest file is invisible.
    expect((await api(`/api/v1/files/${d.file_id}/finalize`, { method: "POST", json: {} })).status).toBe(404);
    expect((await api(`/api/v1/files/${d.file_id}/finalize`, { method: "POST", json: { owner_token: "nope" } })).status).toBe(404);
    const fin = await api(`/api/v1/files/${d.file_id}/finalize`, { method: "POST", json: { owner_token: d.owner_token } });
    expect(fin.status).toBe(200);
    const f = await json(fin);
    expect(f.status).toBe("active");
    expect(f.access_status).toBe("expiring");
    expect(f.serve_url).toBe(`https://share.example.com/f/${d.short_code}/g.txt`);

    const st = await api(`/api/v1/files/${d.file_id}/status?owner_token=${encodeURIComponent(d.owner_token)}`);
    expect(st.status).toBe(200);
    expect(await json(st)).toMatchObject({ status: "active", seen: false, view_count: 0 });
    const denied = await api(`/api/v1/files/${d.file_id}/status`);
    expect(denied.status).toBe(403);
    expect(await json(denied)).toEqual({ detail: "Not authorized for this file." });

    // Expired guest file reports "expired".
    await env.DB.prepare("UPDATE file_assets SET expires_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - 1000).toISOString(), d.file_id)
      .run();
    const ex = await json(await api(`/api/v1/files/${d.file_id}/status?owner_token=${encodeURIComponent(d.owner_token)}`));
    expect(ex.status).toBe("expired");
  });

  it("management endpoints require auth", async () => {
    expect((await api("/api/v1/files")).status).toBe(401);
    expect((await api(`/api/v1/files/${crypto.randomUUID()}`, { method: "DELETE" })).status).toBe(401);
  });
});

describe("replace content (test_file_replace.py)", () => {
  it("keeps the link and swaps the bytes", async () => {
    const { headers } = await authedUser();
    const v1 = "<html><body><script>localStorage.x=1</script>v1</body></html>";
    const { init, file } = await uploadFile(headers, v1, "page.html", "text/html");
    expect(file.status).toBe("active");
    const oldKey = (await fileRow(init.file_id))!.storage_key;
    expect(await blobText(oldKey)).toBe(v1);

    const v2 = "<html><body>v2 updated weekly</body></html>";
    const rep = await api(`/api/v1/files/${init.file_id}/content`, {
      method: "PUT",
      body: enc(v2),
      headers: { ...headers, "Content-Type": "text/html" },
    });
    expect(rep.status, await rep.clone().text()).toBe(200);
    const body = await json(rep);
    expect(body.short_code).toBe(init.short_code);
    expect(body.size_bytes).toBe(v2.length);
    expect(body.filename).toBe("page.html");

    const row = (await fileRow(init.file_id))!;
    expect(row.storage_key).not.toBe(oldKey);
    expect(row.short_code).toBe(init.short_code);
    expect(await blobText(row.storage_key)).toBe(v2);
    expect(await eventually(async () => (await env.FILES.head(oldKey)) === null)).toBe(true);
    const expected = await sha256Hex(v2);
    expect(await eventually(async () => (await fileRow(init.file_id))!.sha256 === expected)).toBe(true);

    // Optional rename + type change.
    const rep2 = await api(`/api/v1/files/${init.file_id}/content?filename=notes.txt`, {
      method: "PUT",
      body: enc("plain"),
      headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" },
    });
    const b2 = await json(rep2);
    expect(b2).toMatchObject({ filename: "notes.txt", kind: "other", mime_type: "text/plain", size_bytes: 5 });
  });

  it("rejects non-owners and a missing content type", async () => {
    const owner = await authedUser();
    const other = await authedUser();
    const { init } = await uploadFile(owner.headers, "hello");

    const rep = await api(`/api/v1/files/${init.file_id}/content`, {
      method: "PUT",
      body: enc("pwned"),
      headers: { ...other.headers, "Content-Type": "text/plain" },
    });
    expect(rep.status).toBe(404);
    expect(await blobText((await fileRow(init.file_id))!.storage_key)).toBe("hello");

    const noType = await api(`/api/v1/files/${init.file_id}/content`, { method: "PUT", body: enc("x"), headers: owner.headers });
    expect(noType.status).toBe(400);
    expect(await json(noType)).toEqual({ detail: "Content-Type header is required." });
  });

  it("oversize, empty and not-yet-finalized replacements", async () => {
    const { headers } = await authedUser();
    const { init } = await uploadFile(headers, "hello");
    setSettings({ workerUploadMaxBytes: 4 });
    const big = await api(`/api/v1/files/${init.file_id}/content`, {
      method: "PUT",
      body: enc("12345"),
      headers: { ...headers, "Content-Type": "text/plain" },
    });
    expect(big.status).toBe(413);
    expect((await fileRow(init.file_id))!.size_bytes).toBe(5);

    const empty = await api(`/api/v1/files/${init.file_id}/content`, {
      method: "PUT",
      body: new Uint8Array(0),
      headers: { ...headers, "Content-Type": "text/plain" },
    });
    expect(empty.status).toBe(400);
    expect(await json(empty)).toEqual({ detail: "Empty request body." });

    const pending = await json(await intent(headers, { filename: "p.txt", content_type: "text/plain", size_bytes: 1 }));
    const r = await api(`/api/v1/files/${pending.file_id}/content`, {
      method: "PUT",
      body: enc("x"),
      headers: { ...headers, "Content-Type": "text/plain" },
    });
    expect(r.status).toBe(409);
    expect(await json(r)).toEqual({
      detail: "Cannot replace content from status 'pending_upload'; finalize the original upload first.",
    });
  });
});

describe("manage", () => {
  it("patch project, access settings and delete", async () => {
    const { headers, user } = await authedUser();
    const { init } = await uploadFile(headers, "hello");
    const fid = init.file_id;

    const projectId = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO projects (id, user_id, name, created_at) VALUES (?,?,?,?)")
      .bind(projectId, user.id, "Folder", new Date().toISOString())
      .run();
    const moved = await api(`/api/v1/files/${fid}`, { method: "PATCH", json: { project_id: projectId }, headers });
    expect(moved.status).toBe(200);
    expect((await json(moved)).project_id).toBe(projectId);
    // Omitting the field leaves it alone; null unfiles.
    expect((await json(await api(`/api/v1/files/${fid}`, { method: "PATCH", json: {}, headers }))).project_id).toBe(projectId);
    expect((await json(await api(`/api/v1/files/${fid}`, { method: "PATCH", json: { project_id: null }, headers }))).project_id).toBeNull();
    const missing = await api(`/api/v1/files/${fid}`, { method: "PATCH", json: { project_id: crypto.randomUUID() }, headers });
    expect(missing.status).toBe(404);
    expect(await json(missing)).toEqual({ detail: "Project not found." });
    expect((await api(`/api/v1/files/${fid}`, { method: "PATCH", json: { project_id: "x" }, headers })).status).toBe(400);

    const acc = await api(`/api/v1/files/${fid}/access`, {
      method: "PUT",
      json: { expires_in_hours: 2, max_views: 3, require_email: true, block_vpn: true, branded: true },
      headers,
    });
    expect(acc.status).toBe(200);
    const a = await json(acc);
    expect(a).toMatchObject({ max_views: 3, remaining_views: 3, require_email: true, block_vpn: true, branded: true, revoked: false, access_status: "expiring" });
    expect(Math.abs(Date.parse(a.expires_at) - (Date.now() + 2 * 3600_000))).toBeLessThan(60_000);

    const revoked = await json(await api(`/api/v1/files/${fid}/access`, { method: "PUT", json: { revoked: true }, headers }));
    expect(revoked).toMatchObject({ revoked: true, access_status: "expired", max_views: 3, require_email: true });
    const cleared = await json(
      await api(`/api/v1/files/${fid}/access`, { method: "PUT", json: { revoked: false, max_views: 0, expires_in_hours: 0 }, headers }),
    );
    expect(cleared).toMatchObject({ revoked: false, max_views: null, expires_at: null, access_status: "tracking" });

    const other = await authedUser();
    expect((await api(`/api/v1/files/${fid}`, { method: "DELETE", headers: other.headers })).status).toBe(404);
    const key = (await fileRow(fid))!.storage_key;
    expect((await api(`/api/v1/files/${fid}`, { method: "DELETE", headers })).status).toBe(204);
    expect((await fileRow(fid))!.status).toBe("deleted");
    expect(await eventually(async () => (await env.FILES.head(key)) === null)).toBe(true);
    expect(await json(await api("/api/v1/files", { headers }))).toEqual([]);
    expect((await api(`/api/v1/files/${fid}/status`, { headers })).status).toBe(404);
  });

  it("per-file analytics, leads and page heatmap", async () => {
    const { headers } = await authedUser();
    const { init } = await uploadFile(headers, "hello");
    const fid = init.file_id;
    const now = Date.now();
    const ev = (ip: string, country: string, device: string, browser: string, ageMs = 0) =>
      env.DB.prepare(
        "INSERT INTO click_events (id, file_id, ip_address, country, country_code, region, city, device_type, browser, os, is_vpn, is_revisit, clicked_at) VALUES (?,?,?,?,?,?,?,?,?,?,0,0,?)",
      )
        .bind(crypto.randomUUID(), fid, ip, country, country.slice(0, 2).toUpperCase(), "R", "C", device, browser, "OS", new Date(now - ageMs).toISOString())
        .run();
    await ev("1.1.1.1", "India", "mobile", "Chrome");
    await ev("1.1.1.1", "India", "mobile", "Chrome");
    await ev("2.2.2.2", "Germany", "desktop", "Firefox");
    await ev("3.3.3.3", "Germany", "desktop", "Chrome", 40 * 86_400_000); // outside the 30-day window

    const sum = await json(await api(`/api/v1/files/${fid}/summary`, { headers }));
    expect(sum).toMatchObject({ file_id: fid, short_code: init.short_code, opens: 3, unique_opens: 2, view_count: 0, last_viewed_at: null });
    expect((await json(await api(`/api/v1/files/${fid}/summary?days=60`, { headers }))).opens).toBe(4);
    expect((await api(`/api/v1/files/${fid}/summary?days=0`, { headers })).status).toBe(422);

    const today = new Date(now).toISOString().slice(0, 10);
    const ranged = await json(await api(`/api/v1/files/${fid}/summary?start_date=${today}&end_date=${today}`, { headers }));
    expect(ranged.opens).toBe(3);
    const badRange = await api(`/api/v1/files/${fid}/summary?start_date=2026-02-01&end_date=2026-01-01`, { headers });
    expect(badRange.status).toBe(400);
    expect(await json(badRange)).toEqual({ detail: "start_date must be before end_date." });
    expect(await json(await api(`/api/v1/files/${fid}/summary?start_date=nope&end_date=2026-01-01`, { headers }))).toEqual({
      detail: "Invalid date format. Use ISO 8601 (YYYY-MM-DD).",
    });

    const events = await json(await api(`/api/v1/files/${fid}/events`, { headers }));
    expect(events).toHaveLength(3);
    expect(Object.keys(events[0]).sort()).toEqual(
      ["asn_org", "browser", "city", "clicked_at", "country", "country_code", "device_type", "id", "ip_address", "is_vpn", "os", "referrer", "region"].sort(),
    );
    expect(events[0].is_vpn).toBe(false);

    expect(await json(await api(`/api/v1/files/${fid}/geo`, { headers }))).toEqual([
      { country: "India", country_code: "IN", clicks: 2 },
      { country: "Germany", country_code: "GE", clicks: 1 },
    ]);
    expect((await json(await api(`/api/v1/files/${fid}/geo?level=city`, { headers })))[0]).toEqual({
      country: "India",
      country_code: "IN",
      region: "R",
      city: "C",
      clicks: 2,
    });
    expect((await json(await api(`/api/v1/files/${fid}/geo?level=region`, { headers })))[0]).toEqual({
      country: "India",
      country_code: "IN",
      region: "R",
      clicks: 2,
    });
    expect(await json(await api(`/api/v1/files/${fid}/devices`, { headers }))).toEqual({
      devices: [
        { device_type: "mobile", clicks: 2 },
        { device_type: "desktop", clicks: 1 },
      ],
      browsers: [
        { browser: "Chrome", clicks: 2 },
        { browser: "Firefox", clicks: 1 },
      ],
    });

    await env.DB.prepare("INSERT INTO access_leads (id, file_id, email, ip_address, created_at) VALUES (?,?,?,?,?)")
      .bind(crypto.randomUUID(), fid, "a@b.co", "1.1.1.1", new Date().toISOString())
      .run();
    const leads = await json(await api(`/api/v1/files/${fid}/leads`, { headers }));
    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({ email: "a@b.co", ip_address: "1.1.1.1" });

    for (const [sid, page, ms] of [["s1", 1, 1000], ["s2", 1, 3000], ["s1", 2, 500]] as const) {
      await env.DB.prepare("INSERT INTO page_engagements (id, file_id, session_id, page, dwell_ms, created_at) VALUES (?,?,?,?,?,?)")
        .bind(crypto.randomUUID(), fid, sid, page, ms, new Date().toISOString())
        .run();
    }
    expect(await json(await api(`/api/v1/files/${fid}/pages`, { headers }))).toEqual({
      pages: [
        { page: 1, avg_ms: 2000, total_ms: 4000, sessions: 2 },
        { page: 2, avg_ms: 500, total_ms: 500, sessions: 1 },
      ],
      peak_avg_ms: 2000,
    });

    // Owner only.
    const other = await authedUser();
    expect((await api(`/api/v1/files/${fid}/summary`, { headers: other.headers })).status).toBe(404);
  });
});
