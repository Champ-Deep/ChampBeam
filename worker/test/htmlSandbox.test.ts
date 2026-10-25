/**
 * D3: CSP sandbox on hosted HTML. New pages are sandboxed, legacy pages are not until the owner
 * opts in, the HTML_SANDBOX flag turns it off, and a sandboxed page (Origin: null) can still reach
 * the two endpoints its injected snippet uses (Beam State, dwell beacon) and nothing else.
 */
import { afterEach, describe, expect, it } from "vitest";
import { api, authedUser, env, json } from "./helpers";
import { getSettings, type Env } from "../src/env";
import { newUser, seedPage } from "./serveSeed";

const HTML = "<!doctype html><html><head><title>T</title></head><body>hi</body></html>";
const SANDBOX = /(^|; )sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox$/;
const csp = async (path: string) => (await api(path)).headers.get("content-security-policy") ?? "";

const flag = (v: boolean) => (getSettings(env as unknown as Env).htmlSandbox = v);
afterEach(() => flag(true));

async function publish(headers: Record<string, string>) {
  const r = await api("/api/v1/pages", { method: "POST", json: { html: HTML, title: "Sandbox Page" }, headers });
  expect(r.status, await r.clone().text()).toBe(201);
  return json(r);
}

describe("hosted HTML sandbox (D3)", () => {
  it("sandboxes a page created after the flag, and the owner can opt out and back in", async () => {
    const { headers } = await authedUser();
    const page = await publish(headers);
    expect(page.html_sandbox).toBe(true);
    const url = `/p/${page.slug}`;
    expect(await csp(url)).toMatch(SANDBOX);
    expect(await csp(url)).toContain("frame-ancestors 'none'"); // existing policy is kept

    const off = await api(`/api/v1/pages/${page.page_id}`, { method: "PATCH", json: { html_sandbox: false }, headers });
    expect((await json(off)).html_sandbox).toBe(false);
    expect(await csp(url)).not.toContain("sandbox");
    await api(`/api/v1/pages/${page.page_id}`, { method: "PATCH", json: { html_sandbox: true }, headers });
    expect(await csp(url)).toMatch(SANDBOX);
  });

  it("leaves legacy pages alone until the owner opts in", async () => {
    const p = await seedPage(await newUser(), HTML); // seeded row has html_sandbox NULL, like a pre-0003 page
    expect(await csp(`/p/${p.slug}`)).not.toContain("sandbox");
    await env.DB.prepare("UPDATE file_assets SET html_sandbox = 1 WHERE id = ?").bind(p.id).run();
    expect(await csp(`/p/${p.slug}`)).toMatch(SANDBOX);
  });

  it("HTML_SANDBOX=off disables it everywhere and stops marking new pages", async () => {
    const { headers } = await authedUser();
    const page = await publish(headers);
    flag(false);
    expect(await csp(`/p/${page.slug}`)).not.toContain("sandbox");
    const later = await publish(headers);
    expect(later.html_sandbox).toBe(false);
  });

  it("a sandboxed page (Origin: null) can use Beam State and the dwell beacon, nothing else", async () => {
    const { headers } = await authedUser();
    const page = await publish(headers);
    const served = await api(`/p/${page.slug}`);
    const token = /token:"([^"]+)"/.exec(await served.text())![1];
    const code = page.short_code;
    const origin = { Origin: "null" };

    // Preflights the browser sends for X-Beam-Token and a JSON beacon.
    const pre = (path: string, hdr: string) =>
      api(path, { method: "OPTIONS", headers: { ...origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": hdr } });
    const p1 = await pre(`/api/pages/${page.slug}/comments`, "content-type,x-beam-token");
    expect(p1.status).toBe(200);
    expect(p1.headers.get("access-control-allow-origin")).toBe("null");
    expect(p1.headers.get("access-control-allow-headers")).toContain("X-Beam-Token");
    expect((await pre(`/f/${code}/page-events`, "content-type")).headers.get("access-control-allow-origin")).toBe("null");

    // Real calls: state write and dwell beacon (no cookie: visitor id travels in the body).
    const w = await api(`/api/pages/${page.slug}/comments`, {
      method: "POST",
      headers: { ...origin, "X-Beam-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ author: "A", body: "from a sandbox" }),
    });
    expect(w.status).toBe(201);
    expect(w.headers.get("access-control-allow-origin")).toBe("null");
    const b = await api(`/f/${code}/page-events`, {
      method: "POST",
      headers: { ...origin, "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "s1", visitor_id: "v".repeat(32), events: [{ page: 0, dwell_ms: 1500 }] }),
    });
    expect(b.status).toBeLessThan(300);
    expect(b.headers.get("access-control-allow-origin")).toBe("null");
    const dwell = await env.DB.prepare("SELECT sum(dwell_ms) AS t FROM page_engagements WHERE file_id = ?").bind(page.page_id).first<any>();
    expect(dwell!.t).toBe(1500);

    // Errors keep CORS so the helper can read 410/401 instead of an opaque failure.
    const bad = await api(`/api/pages/${page.slug}/comments`, { headers: { ...origin, "X-Beam-Token": "nope" } });
    expect(bad.status).toBe(401);
    expect(bad.headers.get("access-control-allow-origin")).toBe("null");

    // The null origin gets nothing on the authenticated API.
    const priv = await pre("/api/v1/pages", "authorization");
    expect(priv.status).toBe(400);
    const priv2 = await api("/api/v1/pages", { headers: { ...origin, ...headers } });
    expect(priv2.headers.get("access-control-allow-origin")).toBeNull();
  });
});
