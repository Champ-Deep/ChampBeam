/**
 * /api/v1/utm routes. Ports backend/tests/test_api_utm.py (generate),
 * test_api_keys.py::test_key_link_lifecycle, the two company-intent
 * aggregation tests from test_company_intent.py, test_opens_geo.py, plus
 * coverage of the SQL-translated analytics endpoints (seeded directly).
 */
import { afterEach, describe, expect, it } from "vitest";
import { api, authedUser, env, json } from "./helpers";
import { getSettings, type Env } from "../src/env";
import { pyFloatStr, pyRound2, resolveDateRange } from "../src/routes/_utmHelpers";

const U = "/api/v1/utm";
const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();
const DAY = 86_400_000;

async function seedLink(userId: string, f: Record<string, unknown> = {}): Promise<string> {
  const id = crypto.randomUUID();
  const row: Record<string, unknown> = {
    id,
    user_id: userId,
    original_url: "https://example.com/page",
    tracked_url: "https://example.com/page?utm_source=x",
    short_code: `c${id.slice(0, 6)}`,
    click_count: 0,
    unique_clicks: 0,
    created_at: iso(),
    ...f,
  };
  const cols = Object.keys(row);
  await env.DB.prepare(`INSERT INTO link_clicks (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
    .bind(...cols.map((k) => row[k] as string | number | null))
    .run();
  return id;
}

async function seedFile(userId: string, filename = "d.pdf"): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO file_assets (id, user_id, short_code, filename, kind, mime_type, size_bytes, storage_key, status, serve_mode, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(id, userId, `f${id.slice(0, 6)}`, filename, "pdf", "application/pdf", 1, "k", "active", "stream", iso())
    .run();
  return id;
}

async function seedEvent(f: Record<string, unknown>): Promise<string> {
  const id = crypto.randomUUID();
  const row: Record<string, unknown> = { id, ip_address: "9.9.9.9", is_vpn: 0, clicked_at: iso(), ...f };
  if (typeof row.is_vpn === "boolean") row.is_vpn = row.is_vpn ? 1 : 0;
  const cols = Object.keys(row);
  await env.DB.prepare(`INSERT INTO click_events (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
    .bind(...cols.map((k) => row[k] as string | number | null))
    .run();
  return id;
}

const settings = () => getSettings(env as unknown as Env);
const origProvider = settings().companyIntelProvider;
afterEach(() => {
  settings().companyIntelProvider = origProvider;
});

// ---------------------------------------------------------------------------
// Generate / link management
// ---------------------------------------------------------------------------

describe("POST /utm/generate", () => {
  it("works without auth and records nothing (test_generate_public_link)", async () => {
    const res = await api(`${U}/generate`, {
      method: "POST",
      json: { base_url: "example.com", utm_source: "google", utm_medium: "cpc" },
    });
    expect(res.status).toBe(200);
    const data = await json(res);
    expect(data.original_url).toBe("example.com");
    expect(data.tracked_url).toContain("utm_source=google");
    expect(data.tracked_url).toContain("utm_medium=cpc");
    expect(data.link_id).toBeNull();
    expect(data).toEqual({
      original_url: "example.com",
      tracked_url: data.tracked_url,
      redirect_url: null,
      short_code: null,
      utm_params: { utm_source: "google", utm_medium: "cpc" },
      link_id: null,
      short_url: null,
    });
  });

  it("requires base_url or url", async () => {
    const res = await api(`${U}/generate`, { method: "POST", json: { base_url: "  " } });
    expect(res.status).toBe(422);
    expect(await json(res)).toEqual({ detail: "base_url (or url) is required." });
  });

  it("records a link for an authenticated caller, with preset values overridden by the request", async () => {
    const { headers } = await authedUser();
    const preset = await json(
      await api(`${U}/presets`, {
        method: "POST",
        headers,
        json: { name: "P", utm_source: "news", utm_medium: "email", utm_campaign: "base" },
      }),
    );
    const res = await api(`${U}/generate`, {
      method: "POST",
      headers,
      json: { url: "https://acme.com/x", utm_campaign: "q3", preset_id: preset.id },
    });
    expect(res.status).toBe(200);
    const d = await json(res);
    expect(d.utm_params).toEqual({ utm_source: "news", utm_medium: "email", utm_campaign: "q3" });
    expect(d.link_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(d.short_code).toMatch(/^[A-Za-z0-9]{7}$/);
    expect(d.redirect_url).toBe(`https://share.example.com/r/${d.short_code}`);
    expect(d.short_url).toBe(`https://share.example.com/s/${d.short_code}`);
  });

  it("uses the caller's primary domain, validates an explicit domain_id", async () => {
    const { user, headers } = await authedUser();
    const domId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO domains (id, user_id, hostname, status, is_primary, created_at) VALUES (?,?,?,?,1,?)",
    )
      .bind(domId, user.id, "go.acme.com", "active", iso())
      .run();
    const d = await json(await api(`${U}/generate`, { method: "POST", headers, json: { base_url: "https://acme.com" } }));
    expect(d.redirect_url).toBe(`https://go.acme.com/r/${d.short_code}`);
    expect(d.short_url).toBe(`https://go.acme.com/s/${d.short_code}`);

    const bad = await api(`${U}/generate`, { method: "POST", headers, json: { base_url: "https://a.com", domain_id: "nope" } });
    expect(bad.status).toBe(400);
    expect(await json(bad)).toEqual({ detail: "Invalid domain_id." });
    const missing = await api(`${U}/generate`, {
      method: "POST",
      headers,
      json: { base_url: "https://a.com", domain_id: crypto.randomUUID() },
    });
    expect(missing.status).toBe(404);
    expect(await json(missing)).toEqual({ detail: "Active domain not found." });
  });

  it("API-key link lifecycle: create, list, delete (test_key_link_lifecycle)", async () => {
    const { headers } = await authedUser();
    const created = await api(`${U}/generate`, {
      method: "POST",
      json: { base_url: "https://example.com/doc", utm_campaign: "q3" },
      headers,
    });
    expect(created.status).toBe(200);
    const linkId = (await json(created)).link_id;

    const listed = await api(`${U}/analytics/links`, { headers });
    expect(listed.status).toBe(200);
    expect((await json<any[]>(listed)).some((l) => l.link_id === linkId)).toBe(true);

    const deleted = await api(`${U}/links/${linkId}`, { method: "DELETE", headers });
    expect(deleted.status).toBe(204);
    expect((await json<any[]>(await api(`${U}/analytics/links`, { headers }))).length).toBe(0);
  });
});

describe("link management", () => {
  it("delete: 400 on a bad id, 404 for someone else's link, removes click events", async () => {
    const { user, headers } = await authedUser();
    const other = await authedUser();
    expect(await json(await api(`${U}/links/not-a-uuid`, { method: "DELETE", headers }))).toEqual({
      detail: "Invalid link ID.",
    });
    const foreign = await seedLink(other.user.id);
    const r404 = await api(`${U}/links/${foreign}`, { method: "DELETE", headers });
    expect(r404.status).toBe(404);
    expect(await json(r404)).toEqual({ detail: "Link not found." });

    const mine = await seedLink(user.id);
    await seedEvent({ link_id: mine });
    expect((await api(`${U}/links/${mine}`, { method: "DELETE", headers })).status).toBe(204);
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM click_events WHERE link_id = ?").bind(mine).first<{ n: number }>();
    expect(left!.n).toBe(0);
  });

  it("patch reassigns / clears the project", async () => {
    const { user, headers } = await authedUser();
    const projectId = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO projects (id, user_id, name, created_at) VALUES (?,?,?,?)").bind(projectId, user.id, "P", iso()).run();
    const linkId = await seedLink(user.id);
    const res = await api(`${U}/links/${linkId}`, { method: "PATCH", headers, json: { project_id: projectId } });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toEqual({ id: linkId, project_id: projectId, original_url: "https://example.com/page", short_code: body.short_code });
    const cleared = await json(await api(`${U}/links/${linkId}`, { method: "PATCH", headers, json: { project_id: "" } }));
    expect(cleared.project_id).toBeNull();
  });

  it("access controls round-trip and leads", async () => {
    const { user, headers } = await authedUser();
    const linkId = await seedLink(user.id, { click_count: 2 });
    const initial = await json(await api(`${U}/links/${linkId}/access`, { headers }));
    expect(initial).toEqual({
      link_id: linkId,
      expires_at: null,
      max_views: null,
      remaining_views: null,
      require_email: false,
      block_vpn: false,
      branded: false,
      revoked: false,
      access_status: "tracking",
      views: 2,
    });
    const set = await json(
      await api(`${U}/links/${linkId}/access`, {
        method: "PUT",
        headers,
        json: { expires_in_hours: 2, max_views: 5, require_email: true, branded: true },
      }),
    );
    expect(set.max_views).toBe(5);
    expect(set.remaining_views).toBe(3);
    expect(set.require_email).toBe(true);
    expect(set.branded).toBe(true);
    expect(set.expires_at).toMatch(/Z$/);
    expect(set.access_status).toBe("expiring");

    const revoked = await json(
      await api(`${U}/links/${linkId}/access`, { method: "PUT", headers, json: { revoked: true, max_views: 0 } }),
    );
    expect(revoked.revoked).toBe(true);
    expect(revoked.max_views).toBeNull();
    expect(revoked.access_status).toBe("expired");

    expect(await json(await api(`${U}/links/bad/access`, { headers }))).toEqual({ detail: "Invalid link id." });

    await env.DB.prepare("INSERT INTO access_leads (id, link_id, email, ip_address, created_at) VALUES (?,?,?,?,?)")
      .bind(crypto.randomUUID(), linkId, "a@b.com", "1.2.3.4", "2026-01-01T00:00:00.000Z")
      .run();
    expect(await json(await api(`${U}/links/${linkId}/leads`, { headers }))).toEqual([
      { email: "a@b.com", ip_address: "1.2.3.4", created_at: "2026-01-01T00:00:00.000Z" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Presets / tags / bulk
// ---------------------------------------------------------------------------

describe("presets", () => {
  it("CRUD, default, shared listing", async () => {
    const { user, headers } = await authedUser();
    const other = await authedUser();
    const created = await api(`${U}/presets`, { method: "POST", headers, json: { name: "Mine", utm_source: "s" } });
    expect(created.status).toBe(201);
    const p = await json(created);
    expect(p).toMatchObject({
      user_id: user.id,
      name: "Mine",
      is_default: false,
      is_shared: false,
      utm_source: "s",
      utm_medium: "",
      utm_campaign: "",
      utm_content: null,
      utm_term: null,
      custom_params: null,
    });
    expect(p.created_at).toMatch(/Z$/);

    await api(`${U}/presets`, { method: "POST", headers: other.headers, json: { name: "Shared", is_shared: true } });
    const list = await json<any[]>(await api(`${U}/presets`, { headers }));
    expect(list.map((x) => x.name).sort()).toEqual(["Mine", "Shared"]);

    const upd = await json(
      await api(`${U}/presets/${p.id}`, { method: "PUT", headers, json: { utm_medium: "cpc", custom_params: { a: 1 } } }),
    );
    expect(upd.utm_medium).toBe("cpc");
    expect(upd.utm_source).toBe("s");
    expect(upd.custom_params).toEqual({ a: 1 });

    const def = await json(await api(`${U}/presets/${p.id}/default`, { method: "POST", headers }));
    expect(def.is_default).toBe(true);
    expect((await json(await api(`${U}/presets/${p.id}`, { headers }))).is_default).toBe(true);

    expect((await api(`${U}/presets/${p.id}`, { method: "DELETE", headers })).status).toBe(204);
    const gone = await api(`${U}/presets/${p.id}`, { headers });
    expect(gone.status).toBe(404);
    expect(await json(gone)).toEqual({ detail: "UTM preset not found" });
  });

  it("requires auth", async () => {
    expect((await api(`${U}/presets`)).status).toBe(401);
  });
});

describe("tags", () => {
  it("create, list, tag a link, untag, delete", async () => {
    const { user, headers } = await authedUser();
    expect(await json(await api(`${U}/tags`, { method: "POST", headers, json: { name: "  " } }))).toEqual({
      detail: "Tag name is required",
    });
    const b = await json(await api(`${U}/tags`, { method: "POST", headers, json: { name: "b", color: "#fff" } }));
    const createdRes = await api(`${U}/tags`, { method: "POST", headers, json: { name: "a" } });
    expect(createdRes.status).toBe(201);
    const a = await json(createdRes);
    expect(a).toEqual({ id: a.id, name: "a", color: null, created_at: a.created_at });
    expect((await json<any[]>(await api(`${U}/tags`, { headers }))).map((t) => t.name)).toEqual(["a", "b"]);

    const linkId = await seedLink(user.id);
    const t1 = await api(`${U}/links/${linkId}/tags/${b.id}`, { method: "POST", headers });
    expect(t1.status).toBe(201);
    expect(await json(t1)).toEqual({ status: "tagged" });
    const t2 = await api(`${U}/links/${linkId}/tags/${b.id}`, { method: "POST", headers });
    expect(t2.status).toBe(201);
    expect(await json(t2)).toEqual({ status: "already_tagged" });

    expect((await api(`${U}/links/${linkId}/tags/${b.id}`, { method: "DELETE", headers })).status).toBe(204);
    const again = await api(`${U}/links/${linkId}/tags/${b.id}`, { method: "DELETE", headers });
    expect(again.status).toBe(404);
    expect(await json(again)).toEqual({ detail: "Tag not associated with this link" });

    const noLink = await api(`${U}/links/${crypto.randomUUID()}/tags/${b.id}`, { method: "POST", headers });
    expect(await json(noLink)).toEqual({ detail: "Link not found" });

    expect((await api(`${U}/tags/${b.id}`, { method: "DELETE", headers })).status).toBe(204);
    expect(await json(await api(`${U}/tags/${b.id}`, { method: "DELETE", headers }))).toEqual({ detail: "Tag not found" });
  });
});

describe("bulk CSV", () => {
  it("serves the template", async () => {
    const res = await api(`${U}/bulk/template`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe("attachment; filename=utm_template.csv");
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(await res.text()).toBe(
      "url,utm_source,utm_medium,utm_campaign,utm_content,utm_term\nhttps://example.com,google,cpc,summer-sale,,\n",
    );
  });

  it("generates tracked links and persists each row", async () => {
    const { user, headers } = await authedUser();
    const fd = new FormData();
    fd.append("file", new File(["url,utm_source\nhttps://a.com,fb\n,\nnodot,x\n"], "links.csv", { type: "text/csv" }));
    const res = await api(`${U}/bulk/generate`, { method: "POST", headers, body: fd });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe("attachment; filename=utm_links.csv");
    const lines = (await res.text()).split("\r\n");
    expect(lines[0]).toBe("url,utm_source,tracked_url,short_link,error");
    expect(lines[1]).toMatch(/^https:\/\/a\.com,fb,https:\/\/a\.com\?utm_source=fb,https:\/\/share\.example\.com\/r\/[A-Za-z0-9]{7},$/);
    expect(lines[2]).toBe(",,,,Missing URL");
    expect(lines[3]).toBe("nodot,x,,,Invalid URL format");
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM link_clicks WHERE user_id = ?").bind(user.id).first<{ n: number }>();
    expect(n!.n).toBe(1);
  });

  it("rejects non-CSV, a CSV without a url column, and a missing file", async () => {
    const { headers } = await authedUser();
    const send = (name: string, body: string) => {
      const fd = new FormData();
      fd.append("file", new File([body], name));
      return api(`${U}/bulk/generate`, { method: "POST", headers, body: fd });
    };
    expect(await json(await send("x.txt", "url\n"))).toEqual({ detail: "File must be a CSV" });
    expect(await json(await send("x.csv", "link\nhttps://a.com\n"))).toEqual({ detail: "CSV must contain a 'url' column" });
    const missing = await api(`${U}/bulk/generate`, { method: "POST", headers, body: new FormData() });
    expect(missing.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

describe("analytics: link-level aggregates", () => {
  it("overview totals, rate and top lists", async () => {
    const { user, headers } = await authedUser();
    await seedLink(user.id, { utm_source: "google", utm_campaign: "spring", click_count: 10, unique_clicks: 1 });
    await seedLink(user.id, { utm_source: "fb", utm_campaign: "spring", click_count: 4, unique_clicks: 1 });
    await seedLink(user.id, { utm_source: "fb", click_count: 3, unique_clicks: 0 });
    const other = await authedUser();
    await seedLink(other.user.id, { utm_source: "google", click_count: 100 });

    const body = await json(await api(`${U}/analytics/overview`, { headers }));
    expect(body).toEqual({
      total_tracked_links: 3,
      total_clicks: 17,
      unique_clicks: 2,
      overall_click_rate: 66.67,
      top_sources: [
        { source: "google", clicks: 10 },
        { source: "fb", clicks: 7 },
      ],
      top_campaigns: [{ campaign: "spring", clicks: 14 }],
    });

    const empty = await json(await api(`${U}/analytics/overview`, { headers: (await authedUser()).headers }));
    expect(empty).toEqual({
      total_tracked_links: 0,
      total_clicks: 0,
      unique_clicks: 0,
      overall_click_rate: 0,
      top_sources: [],
      top_campaigns: [],
    });
  });

  it("overview project filter (an unparsable id matches project-less links, like Python)", async () => {
    const { user, headers } = await authedUser();
    const projectId = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO projects (id, user_id, name, created_at) VALUES (?,?,?,?)").bind(projectId, user.id, "P", iso()).run();
    await seedLink(user.id, { project_id: projectId, click_count: 5 });
    await seedLink(user.id, { click_count: 1 });
    expect((await json(await api(`${U}/analytics/overview?project_id=${projectId.toUpperCase()}`, { headers }))).total_clicks).toBe(5);
    expect((await json(await api(`${U}/analytics/overview?project_id=garbage`, { headers }))).total_clicks).toBe(1);
  });

  it("breakdown groups, validates group_by and dates", async () => {
    const { user, headers } = await authedUser();
    await seedLink(user.id, { utm_medium: "cpc", click_count: 2, unique_clicks: 1 });
    await seedLink(user.id, { utm_medium: "cpc", click_count: 1, unique_clicks: 1 });
    await seedLink(user.id, { utm_medium: "email", click_count: 5, unique_clicks: 1 });
    await seedLink(user.id, { utm_medium: "old", created_at: iso(40 * DAY) });
    const rows = await json<any[]>(await api(`${U}/analytics/breakdown?group_by=medium`, { headers }));
    expect(rows).toEqual([
      { group_key: "medium", group_value: "email", total_links: 1, total_clicks: 5, unique_clicks: 1, click_rate: 100 },
      { group_key: "medium", group_value: "cpc", total_links: 2, total_clicks: 3, unique_clicks: 2, click_rate: 100 },
    ]);
    const bad = await api(`${U}/analytics/breakdown?group_by=nope`, { headers });
    expect(bad.status).toBe(400);
    expect(await json(bad)).toEqual({ detail: "Invalid group_by 'nope'. Must be: source, medium, campaign, content, term" });
    expect((await api(`${U}/analytics/breakdown?days=0`, { headers })).status).toBe(422);
    const badDate = await api(`${U}/analytics/breakdown?start_date=xx&end_date=2026-01-01`, { headers });
    expect(await json(badDate)).toEqual({ detail: "Invalid date format. Use ISO 8601 (YYYY-MM-DD)." });
    const inverted = await api(`${U}/analytics/breakdown?start_date=2026-02-01&end_date=2026-01-01`, { headers });
    expect(await json(inverted)).toEqual({ detail: "start_date must be before end_date." });
  });

  it("explicit date range includes the whole end day", async () => {
    const { user, headers } = await authedUser();
    await seedLink(user.id, { utm_source: "a", created_at: "2025-03-10T23:59:58.000Z" });
    await seedLink(user.id, { utm_source: "b", created_at: "2025-03-11T00:00:01.000Z" });
    await seedLink(user.id, { utm_source: "c", created_at: "2025-03-09T23:59:59.000Z" });
    const rows = await json<any[]>(
      await api(`${U}/analytics/links?start_date=2025-03-10&end_date=2025-03-10`, { headers }),
    );
    expect(rows.map((r) => r.utm_source)).toEqual(["a"]);
  });

  it("links: shape, ordering, custom-domain redirect url", async () => {
    const { user, headers } = await authedUser();
    const domId = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO domains (id, user_id, hostname, status, created_at) VALUES (?,?,?,?,?)")
      .bind(domId, user.id, "go.x.com", "active", iso())
      .run();
    const a = await seedLink(user.id, { click_count: 1, short_code: "AAAAAAA", first_clicked_at: "2026-01-02T03:04:05.000Z" });
    const b = await seedLink(user.id, { click_count: 9, short_code: "BBBBBBB", domain_id: domId });
    const rows = await json<any[]>(await api(`${U}/analytics/links`, { headers }));
    expect(rows.map((r) => r.link_id)).toEqual([b, a]);
    expect(rows[0].redirect_url).toBe("https://go.x.com/r/BBBBBBB");
    expect(rows[1]).toMatchObject({
      redirect_url: "https://share.example.com/r/AAAAAAA",
      short_code: "AAAAAAA",
      anchor_text: null,
      project_id: null,
      click_count: 1,
      unique_clicks: 0,
      first_clicked_at: "2026-01-02T03:04:05.000Z",
    });
  });

  it("performance buckets links by creation day", async () => {
    const { user, headers } = await authedUser();
    const today = iso().slice(0, 10);
    const yesterday = iso(DAY).slice(0, 10);
    await seedLink(user.id, { created_at: `${today}T00:00:01.000Z`, click_count: 2, unique_clicks: 1 });
    await seedLink(user.id, { created_at: `${today}T00:00:02.000Z`, click_count: 3, unique_clicks: 2 });
    await seedLink(user.id, { created_at: `${yesterday}T12:00:00.000Z`, click_count: 1, unique_clicks: 1 });
    const body = await json(await api(`${U}/analytics/performance?days=7`, { headers }));
    expect(body).toEqual({
      days: 7,
      data: [
        { date: `${yesterday}T00:00:00`, links_created: 1, total_clicks: 1, unique_clicks: 1 },
        { date: `${today}T00:00:00`, links_created: 2, total_clicks: 5, unique_clicks: 3 },
      ],
    });
  });
});

describe("analytics: per-link", () => {
  it("events, geo levels, devices; 404 for foreign links", async () => {
    const { user, headers } = await authedUser();
    const link = await seedLink(user.id);
    await seedEvent({ link_id: link, country: "India", country_code: "IN", region: "KA", city: "Bengaluru", device_type: "mobile", browser: "Chrome", clicked_at: iso(1000) });
    await seedEvent({ link_id: link, country: "India", country_code: "IN", region: "MH", city: "Mumbai", device_type: "mobile", browser: "Safari", is_vpn: 1 });
    await seedEvent({ link_id: link, country: "France", country_code: "FR", device_type: "desktop", browser: "Chrome" });
    await seedEvent({ link_id: link, country: "France", country_code: "FR", clicked_at: iso(60 * DAY) });

    const events = await json<any[]>(await api(`${U}/analytics/links/${link}/events`, { headers }));
    expect(events.length).toBe(3);
    expect(Object.keys(events[0])).toEqual([
      "id", "ip_address", "device_type", "browser", "os", "country", "country_code", "region", "city", "referrer", "is_vpn", "asn_org", "clicked_at",
    ]);
    expect(events.filter((e) => e.is_vpn).length).toBe(1);
    expect(events[2].city).toBe("Bengaluru"); // oldest last

    expect(await json(await api(`${U}/analytics/links/${link}/geo`, { headers }))).toEqual([
      { country: "India", country_code: "IN", clicks: 2 },
      { country: "France", country_code: "FR", clicks: 1 },
    ]);
    const region = await json<any[]>(await api(`${U}/analytics/links/${link}/geo?level=region`, { headers }));
    expect(region.length).toBe(3);
    expect(Object.keys(region[0])).toEqual(["country", "country_code", "region", "clicks"]);
    const city = await json<any[]>(await api(`${U}/analytics/links/${link}/geo?level=city&days=365`, { headers }));
    expect(city.reduce((s, r) => s + r.clicks, 0)).toBe(4);

    const dev = await json(await api(`${U}/analytics/links/${link}/devices`, { headers }));
    expect(dev).toEqual({
      devices: [
        { device_type: "mobile", clicks: 2 },
        { device_type: "desktop", clicks: 1 },
      ],
      browsers: [
        { browser: "Chrome", clicks: 2 },
        { browser: "Safari", clicks: 1 },
      ],
    });

    const other = await authedUser();
    const nf = await api(`${U}/analytics/links/${link}/events`, { headers: other.headers });
    expect(nf.status).toBe(404);
    expect(await json(nf)).toEqual({ detail: "Link not found" });
  });
});

describe("analytics: campaigns", () => {
  async function seedCampaigns() {
    const s = await authedUser();
    const today = iso().slice(0, 10);
    const l1 = await seedLink(s.user.id, { utm_campaign: "Spring Sale", utm_source: "google", utm_medium: "cpc", click_count: 3, unique_clicks: 2, last_clicked_at: `${today}T10:00:00.000Z` });
    const l2 = await seedLink(s.user.id, { utm_campaign: "Spring Sale", utm_source: "fb", utm_medium: "social", click_count: 1, unique_clicks: 1 });
    const l3 = await seedLink(s.user.id, { utm_campaign: "fall", utm_source: "fb", click_count: 7, unique_clicks: 3 });
    await seedLink(s.user.id, { utm_campaign: "", click_count: 50 });
    await seedEvent({ link_id: l1, ip_address: "1.1.1.1", country: "India", country_code: "IN", device_type: "mobile", browser: "Chrome", os: "Android", clicked_at: `${today}T00:00:01.000Z` });
    await seedEvent({ link_id: l1, ip_address: "1.1.1.1", country: "India", country_code: "IN", device_type: "mobile", browser: "Chrome", os: "Android", clicked_at: `${today}T00:00:02.000Z` });
    await seedEvent({ link_id: l2, ip_address: "2.2.2.2", country: "France", country_code: "FR", device_type: "desktop", browser: "Firefox", os: "Linux", clicked_at: iso(DAY) });
    await seedEvent({ link_id: l3, ip_address: "3.3.3.3", country: "Spain", country_code: "ES" });
    return { ...s, today, l1, l2, l3 };
  }

  it("list excludes blank campaign names and computes rate", async () => {
    const { headers, today } = await seedCampaigns();
    const rows = await json<any[]>(await api(`${U}/analytics/campaigns`, { headers }));
    expect(rows.map((r) => r.campaign)).toEqual(["fall", "Spring Sale"]);
    expect(rows[1]).toMatchObject({
      total_links: 2,
      total_clicks: 4,
      unique_clicks: 3,
      click_rate: 150,
      last_click_at: `${today}T10:00:00.000Z`,
    });
    expect(rows[1].first_link_created).toMatch(/Z$/);
    expect(rows[0].last_click_at).toBeNull();
  });

  it("detail, geo, devices, links, timeline (URL-encoded name)", async () => {
    const { headers, today, l1, l2 } = await seedCampaigns();
    const name = encodeURIComponent("Spring Sale");
    const detail = await json(await api(`${U}/analytics/campaigns/${name}`, { headers }));
    expect(detail).toEqual({
      campaign: "Spring Sale",
      total_links: 2,
      total_clicks: 4,
      unique_clicks: 3,
      click_rate: 150,
      sources: [
        { source: "google", clicks: 3 },
        { source: "fb", clicks: 1 },
      ],
      mediums: [
        { medium: "cpc", clicks: 3 },
        { medium: "social", clicks: 1 },
      ],
    });

    expect(await json(await api(`${U}/analytics/campaigns/${name}/geo`, { headers }))).toEqual([
      { country: "India", country_code: "IN", clicks: 2 },
      { country: "France", country_code: "FR", clicks: 1 },
    ]);
    const devices = await json(await api(`${U}/analytics/campaigns/${name}/devices`, { headers }));
    expect(devices).toEqual({
      devices: [
        { device_type: "mobile", clicks: 2 },
        { device_type: "desktop", clicks: 1 },
      ],
      browsers: [
        { browser: "Chrome", clicks: 2 },
        { browser: "Firefox", clicks: 1 },
      ],
      os: [
        { os: "Android", clicks: 2 },
        { os: "Linux", clicks: 1 },
      ],
    });
    const links = await json<any[]>(await api(`${U}/analytics/campaigns/${name}/links`, { headers }));
    expect(links.map((l) => l.link_id)).toEqual([l1, l2]);
    expect(Object.keys(links[0])).toEqual([
      "link_id", "original_url", "tracked_url", "redirect_url", "short_code", "utm_source", "utm_medium", "click_count", "unique_clicks", "created_at",
    ]);
    const timeline = await json(await api(`${U}/analytics/campaigns/${name}/timeline`, { headers }));
    expect(timeline).toEqual({
      campaign: "Spring Sale",
      data: [
        { date: `${iso(DAY).slice(0, 10)}T00:00:00`, clicks: 1, unique_clicks: 1 },
        { date: `${today}T00:00:00`, clicks: 2, unique_clicks: 1 },
      ],
    });
  });

  it("compare validates count and returns per-campaign blocks", async () => {
    const { headers } = await seedCampaigns();
    const bad = await api(`${U}/analytics/campaigns/compare?campaigns=one`, { headers });
    expect(bad.status).toBe(400);
    expect(await json(bad)).toEqual({ detail: "Provide 2-4 campaign names separated by commas." });
    expect((await api(`${U}/analytics/campaigns/compare`, { headers })).status).toBe(422);

    const body = await json(await api(`${U}/analytics/campaigns/compare?campaigns=Spring%20Sale,%20fall`, { headers }));
    expect(body.campaigns.map((c: any) => c.campaign)).toEqual(["Spring Sale", "fall"]);
    const spring = body.campaigns[0];
    expect(spring).toMatchObject({ total_links: 2, total_clicks: 4, unique_clicks: 3, click_rate: 150 });
    expect(spring.top_countries[0]).toEqual({ country: "India", country_code: "IN", clicks: 2 });
    expect(spring.top_devices[0]).toEqual({ device_type: "mobile", clicks: 2 });
    expect(spring.timeline.length).toBe(2);
    expect(spring.timeline[1].date).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00$/);
    expect(body.campaigns[1].top_countries).toEqual([{ country: "Spain", country_code: "ES", clicks: 1 }]);
  });

  it("geo overview across links, filtered by campaign", async () => {
    const { headers } = await seedCampaigns();
    const all = await json<any[]>(await api(`${U}/analytics/geo/overview`, { headers }));
    expect(all.reduce((s, r) => s + r.clicks, 0)).toBe(4);
    const fall = await json<any[]>(await api(`${U}/analytics/geo/overview?campaign=fall&level=city`, { headers }));
    expect(fall).toEqual([{ country: "Spain", country_code: "ES", region: null, city: null, clicks: 1 }]);
  });
});

describe("analytics: exports", () => {
  it("click events CSV", async () => {
    const { user, headers } = await authedUser();
    const link = await seedLink(user.id, { original_url: "https://a.com/x,y", short_code: "SHORT01", utm_campaign: "c1" });
    await seedEvent({ link_id: link, ip_address: "1.1.1.1", country: "India", clicked_at: "2099-01-01T00:00:00.000Z" });
    await seedEvent({ link_id: link, is_vpn: 1, asn_org: "Acme", clicked_at: iso(1000) });
    const res = await api(`${U}/analytics/export/events?start_date=2000-01-01&end_date=2100-01-01`, { headers });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe("attachment; filename=click_events.csv");
    const lines = (await res.text()).split("\r\n");
    expect(lines[0]).toBe(
      "clicked_at,original_url,short_code,utm_source,utm_medium,utm_campaign,utm_content,utm_term,ip_address,country,region,city,device_type,browser,os,referrer,is_vpn,asn_org",
    );
    expect(lines[1]).toBe('2099-01-01T00:00:00.000Z,"https://a.com/x,y",SHORT01,,,c1,,,1.1.1.1,India,,,,,,,false,');
    expect(lines[2]).toMatch(/,true,Acme$/);
    expect(lines[3]).toBe("");
  });

  it("campaign summary CSV writes Python floats", async () => {
    const { user, headers } = await authedUser();
    await seedLink(user.id, { utm_campaign: "c1", click_count: 4, unique_clicks: 1 });
    await seedLink(user.id, { utm_campaign: "c1", click_count: 2, unique_clicks: 1 });
    await seedLink(user.id, { utm_campaign: "c2", click_count: 1, unique_clicks: 1, last_clicked_at: "2026-01-01T00:00:00.000Z" });
    await seedLink(user.id, { utm_campaign: "c3", click_count: 0, unique_clicks: 1 });
    await seedLink(user.id, { utm_campaign: "c3", click_count: 0, unique_clicks: 0 });
    await seedLink(user.id, { utm_campaign: "c3", click_count: 0, unique_clicks: 0 });
    const res = await api(`${U}/analytics/export/campaign-summary`, { headers });
    expect(res.headers.get("content-disposition")).toBe("attachment; filename=campaign_summary.csv");
    const lines = (await res.text()).split("\r\n");
    expect(lines[0]).toBe("campaign,total_links,total_clicks,unique_clicks,click_rate,first_created,last_clicked");
    expect(lines[1]).toMatch(/^c1,2,6,2,100\.0,\d{4}-.*Z,$/);
    expect(lines[2]).toBe(`c2,1,1,1,100.0,${lines[2].split(",")[5]},2026-01-01T00:00:00.000Z`);
    expect(lines[3]).toMatch(/^c3,3,0,1,33\.33,/);
  });

  it("link performance CSV", async () => {
    const { user, headers } = await authedUser();
    await seedLink(user.id, { project_name: "Proj", click_count: 2, utm_source: "s" });
    const res = await api(`${U}/analytics/export/link-performance`, { headers });
    expect(res.headers.get("content-disposition")).toBe("attachment; filename=link_performance.csv");
    const lines = (await res.text()).split("\r\n");
    expect(lines[0]).toBe(
      "original_url,tracked_url,short_code,utm_source,utm_medium,utm_campaign,utm_content,utm_term,project_name,click_count,unique_clicks,created_at",
    );
    expect(lines[1]).toMatch(/^https:\/\/example\.com\/page,https:\/\/example\.com\/page\?utm_source=x,c\w+,s,,,,,Proj,2,0,.*Z$/);
  });
});

describe("analytics: recent clicks feed", () => {
  it("returns link clicks and file opens after `since`", async () => {
    const { user, headers } = await authedUser();
    const link = await seedLink(user.id, { utm_campaign: "c", short_code: "LINK001" });
    const file = await seedFile(user.id, "deck.pdf");
    await seedEvent({ link_id: link, clicked_at: iso(1000), country: "India" });
    await seedEvent({ file_id: file, clicked_at: iso(2000) });
    await seedEvent({ link_id: link, clicked_at: iso(10 * 60_000) }); // outside default 5 min
    const other = await authedUser();
    await seedEvent({ link_id: await seedLink(other.user.id), clicked_at: iso(1000) });

    const rows = await json<any[]>(await api(`${U}/analytics/clicks/recent`, { headers }));
    expect(rows.map((r) => r.type)).toEqual(["link", "file"]);
    expect(rows[0]).toMatchObject({ link_id: link, file_id: null, filename: null, short_code: "LINK001", utm_campaign: "c", country: "India" });
    expect(rows[1]).toMatchObject({ link_id: null, file_id: file, filename: "deck.pdf", original_url: null });
    expect(rows[1].short_code).toMatch(/^f/);

    const since = encodeURIComponent(iso(1500).replace(".000Z", "Z"));
    expect((await json<any[]>(await api(`${U}/analytics/clicks/recent?since=${since}`, { headers }))).length).toBe(1);
    const bad = await api(`${U}/analytics/clicks/recent?since=yesterday`, { headers });
    expect(bad.status).toBe(400);
    expect(await json(bad)).toEqual({ detail: "Invalid timestamp format" });
  });
});

// ---------------------------------------------------------------------------
// Company intent (test_company_intent.py) and opens geo (test_opens_geo.py)
// ---------------------------------------------------------------------------

describe("analytics: company intent", () => {
  async function seed() {
    const s = await authedUser();
    const linkId = await seedLink(s.user.id, { original_url: "https://acme.com/q3" });
    const fileId = await seedFile(s.user.id, "pitch-deck.pdf");
    return { ...s, linkId, fileId };
  }

  it("aggregates, filters and assigns temperatures", async () => {
    settings().companyIntelProvider = "asn";
    const { headers, linkId, fileId } = await seed();
    const now = iso();
    // Stripe: 3 firmographic opens today on the deck -> Hot.
    for (let i = 0; i < 3; i++) {
      await seedEvent({ file_id: fileId, company_name: "Stripe", company_domain: "stripe.com", company_type: "business", city: "San Francisco", country: "United States", clicked_at: now });
    }
    // Notion Labs: 1 firmographic open today -> Warm.
    await seedEvent({ link_id: linkId, company_name: "Notion Labs", company_domain: "notion.so", company_type: "business", clicked_at: now });
    // A hosting-type firmographic hit -> filtered out.
    await seedEvent({ link_id: linkId, company_name: "AWS EC2", company_type: "hosting", clicked_at: now });
    // VPN open -> filtered out.
    await seedEvent({ file_id: fileId, company_name: "Ghost", company_type: "business", is_vpn: true, clicked_at: now });
    // Free ASN fallback: a real business network -> included as source=network.
    await seedEvent({ link_id: linkId, asn_org: "Globex Corporation", clicked_at: now });
    // Free ASN fallback: a consumer ISP -> dropped as noise.
    await seedEvent({ link_id: linkId, asn_org: "Comcast Cable Communications", clicked_at: now });

    const resp = await api(`${U}/analytics/company-intent?days=14`, { headers });
    expect(resp.status).toBe(200);
    const body = await json(resp);
    expect(body.provider).toBe("asn");
    const byName = Object.fromEntries(body.companies.map((c: any) => [c.name, c]));
    expect(new Set(Object.keys(byName))).toEqual(new Set(["Stripe", "Notion Labs", "Globex Corporation"]));

    expect(byName["Stripe"].opens).toBe(3);
    expect(byName["Stripe"].temperature).toBe("hot");
    expect(byName["Stripe"].source).toBe("firmographic");
    expect(byName["Stripe"].last_asset).toBe("pitch-deck.pdf");
    expect(byName["Stripe"].country).toBe("United States");

    expect(byName["Notion Labs"].temperature).toBe("warm");
    expect(byName["Notion Labs"].last_asset).toBe("https://acme.com/q3");
    expect(byName["Globex Corporation"].source).toBe("network");
    // Hot sorts above warm.
    expect(body.companies[0].name).toBe("Stripe");
  });

  it("marks a stale company cool", async () => {
    settings().companyIntelProvider = "asn";
    const { headers, linkId } = await seed();
    await seedEvent({ link_id: linkId, company_name: "Figma", company_domain: "figma.com", company_type: "business", clicked_at: iso(12 * DAY) });
    const body = await json(await api(`${U}/analytics/company-intent?days=30`, { headers }));
    expect(body.companies[0].name).toBe("Figma");
    expect(body.companies[0].temperature).toBe("cool");
  });

  it("empty for a caller with no links or files", async () => {
    const { headers } = await authedUser();
    expect(await json(await api(`${U}/analytics/company-intent`, { headers }))).toEqual({
      provider: settings().companyIntelProvider,
      companies: [],
    });
  });
});

describe("analytics: opens geo (test_opens_geo.py)", () => {
  it("aggregates opens by country, city and day", async () => {
    const { user, headers } = await authedUser();
    const linkId = await seedLink(user.id, { short_code: "l1", original_url: "https://e.com" });
    const fileId = await seedFile(user.id);
    const now = iso();
    const ev = (target: string, ip: string, country: string | null, cc: string | null, city: string | null, when: string) =>
      seedEvent({ ...(target === linkId ? { link_id: target } : { file_id: target }), ip_address: ip, country, country_code: cc, city, clicked_at: when });
    // US: 3 opens (2 unique IPs) across a link + file; UK: 1 open; 1 with no geo.
    await ev(linkId, "1.1.1.1", "United States", "US", "San Francisco", now);
    await ev(linkId, "1.1.1.1", "United States", "US", "San Francisco", now);
    await ev(fileId, "2.2.2.2", "United States", "US", "New York", now);
    await ev(linkId, "3.3.3.3", "United Kingdom", "GB", "London", iso(DAY));
    await ev(linkId, "4.4.4.4", null, null, null, now);

    const body = await json(await api(`${U}/analytics/geo?days=30`, { headers }));
    expect(body.total_opens).toBe(5);
    const countries = Object.fromEntries(body.countries.map((c: any) => [c.country, c]));
    expect(countries["United States"].opens).toBe(3);
    expect(countries["United States"].unique_opens).toBe(2);
    expect(countries["United Kingdom"].opens).toBe(1);
    expect(body.countries[0].country).toBe("United States"); // sorted by opens
    expect("null" in countries).toBe(false); // geo-less opens excluded from the map

    expect(new Set(body.cities.map((c: any) => c.city))).toEqual(new Set(["San Francisco", "New York", "London"]));

    // Two distinct days present in the trend.
    expect(body.by_day.length).toBe(2);
    expect(body.by_day.reduce((s: number, d: any) => s + d.opens, 0)).toBe(5);
    expect(body.by_day[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("empty shape for a caller with nothing", async () => {
    const { headers } = await authedUser();
    expect(await json(await api(`${U}/analytics/geo`, { headers }))).toEqual({
      total_opens: 0,
      countries: [],
      cities: [],
      by_day: [],
    });
  });
});

describe("python-compat helpers", () => {
  it("round(x, 2) ties to even on exact values; float repr in CSV", () => {
    expect(pyRound2(3.125)).toBe(3.12);
    expect(pyRound2(3.375)).toBe(3.38);
    expect(pyRound2((2 / 3) * 100)).toBe(66.67);
    expect(pyRound2(2.675)).toBe(2.67); // 2.675 is really 2.67499999...
    expect(pyFloatStr(100)).toBe("100.0");
    expect(pyFloatStr(33.33)).toBe("33.33");
  });

  it("date range end is extended to 23:59:59", () => {
    expect(resolveDateRange(30, "2026-01-01", "2026-01-31")).toEqual(["2026-01-01T00:00:00.000Z", "2026-01-31T23:59:59.000Z"]);
  });
});
