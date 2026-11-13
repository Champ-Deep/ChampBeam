import { describe, it, expect } from "vitest";
import { api, authedUser, json, env, createOrg, addMember, sessionHeaders } from "./helpers";

async function page(headers: Record<string, string>, title = "Preview sample") {
  const r = await api("/api/v1/pages", { method: "POST", headers, json: { title,
    html: '<!doctype html><html><head><meta http-equiv="refresh" content="0;url=https://example.invalid"><style>h1{color:red}</style></head><body><h1>Real hero</h1><script>fetch("/api/v1/files")</script><a href="https://example.invalid" ping="/track">Read</a></body></html>',
  } });
  expect(r.status).toBe(201);
  return json(r);
}
async function event(id: string, userAgent = "Browser", visitor = "returning-browser") {
  await env.DB.prepare("INSERT INTO click_events(id,file_id,visitor_id,clicked_at,user_agent,device_type,is_revisit,country) VALUES(?,?,?,?,?,'desktop',1,'India')")
    .bind(crypto.randomUUID(), id, visitor, new Date().toISOString(), userAgent).run();
}

describe("owner previews and asset analytics", () => {
  it("previews without tracking or executable content, rejecting other owners and deleted assets", async () => {
    const a = await authedUser(), b = await authedUser();
    const item = await page(a.headers);
    const r = await api(`/api/v1/pages/${item.page_id}/preview`, { headers: a.headers });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-security-policy")).toContain("sandbox; default-src 'none'");
    expect(r.headers.get("cache-control")).toBe("private, no-store");
    const html = await r.text();
    expect(html).toContain("Real hero");
    expect(html).not.toMatch(/<script|<meta|href=|ping=/);
    expect((await env.DB.prepare("SELECT view_count FROM file_assets WHERE id=?").bind(item.page_id).first<{view_count:number}>())?.view_count).toBe(0);
    expect((await env.DB.prepare("SELECT count(*) n FROM click_events WHERE file_id=?").bind(item.page_id).first<{n:number}>())?.n).toBe(0);
    expect((await api(`/api/v1/pages/${item.page_id}/preview`, { headers: b.headers })).status).toBe(404);
    expect((await api(`/api/v1/pages/${item.page_id}/preview`)).status).toBe(401);
    await api(`/api/v1/pages/${item.page_id}`, { method: "DELETE", headers: a.headers });
    expect((await api(`/api/v1/pages/${item.page_id}/preview`, { headers: a.headers })).status).toBe(404);
  });

  it("aggregates all events, separates files/pages and excludes scanners and other owners", async () => {
    const a = await authedUser(), b = await authedUser();
    const item = await page(a.headers, "Asset stats");
    const other = await page(b.headers, "Not your asset");
    await event(item.page_id); await event(item.page_id); await event(item.page_id, "Proofpoint scanner"); await event(other.page_id);
    const r = await api("/api/v1/analytics/assets", { headers: a.headers });
    expect(r.status, await r.clone().text()).toBe(200);
    const data = await json(r);
    expect(data.summary).toMatchObject({ opens: 2, page_opens: 2, unique_visitors: 1, returning_opens: 2 });
    expect(data.assets).toHaveLength(1);
    expect(data.countries).toEqual([{ label: "India", opens: 2 }]);
    expect(data.hours.reduce((n: number, h: { opens: number }) => n + h.opens, 0)).toBe(2);
    expect(data.meta.timezone).toBe("UTC");
    expect((await api("/api/v1/analytics/assets?scope=workspace", { headers: a.headers })).status).toBe(403);
    expect((await api("/api/v1/analytics/assets?start_date=2026-01-01", { headers: a.headers })).status).toBe(400);
    expect((await api("/api/v1/analytics/assets")).status).toBe(401);
  });

  it("does not include a member's personal assets in org reporting", async () => {
    const admin = await authedUser(), member = await authedUser();
    const org = await createOrg();
    await addMember(org.id, admin.user.id, "admin");
    await addMember(org.id, member.user.id, "member");
    const personal = await page(member.headers, "Personal private");
    await event(personal.page_id);
    const orgPage = await page(await sessionHeaders(member.user.id, org.id), "Org shared");
    await event(orgPage.page_id);
    const r = await api("/api/v1/analytics/assets?scope=workspace", { headers: await sessionHeaders(admin.user.id, org.id) });
    expect(r.status, await r.clone().text()).toBe(200);
    const data = await json(r);
    expect(data.assets.map((a: {id:string})=>a.id)).toEqual([orgPage.page_id]);
    expect(data.summary.opens).toBe(1);
    expect((await api("/api/v1/analytics/assets?scope=workspace", { headers: await sessionHeaders(member.user.id, org.id) })).status).toBe(403);
  });
});
