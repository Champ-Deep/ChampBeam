#!/usr/bin/env node
/**
 * End-to-end smoke test against a RUNNING deployment (wrangler dev or prod).
 * Exercises the same journeys the SPA and shared links do:
 *
 *   SPA shell -> health -> generate tracked link -> follow /r/{code} -> click
 *   shows in analytics -> upload a file (intent, blob PUT, finalize) -> serve
 *   /f/{code} incl. a Range request -> publish a Beam Page -> serve /p/{slug}
 *   with the tracking snippet -> projects CRUD -> cleanup.
 *
 * Usage:
 *   node scripts/e2e-smoke.mjs <base-url> <api-key>
 *   (an API key is a "cb_live_..." key; locally, scripts/e2e-local.sh mints one)
 */

const [base = "http://127.0.0.1:8787", apiKey] = process.argv.slice(2);
if (!apiKey) {
  console.error("usage: node scripts/e2e-smoke.mjs <base-url> <cb_live_ api key>");
  process.exit(2);
}

const auth = { "X-API-Key": apiKey };
let failures = 0;

function check(name, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`);
  if (!cond) failures++;
}

async function call(method, path, { json, body, headers = {}, redirect = "manual" } = {}) {
  const h = { ...headers };
  if (json !== undefined) h["Content-Type"] = "application/json";
  const url = path.startsWith("http") ? path : `${base}${path}`;
  return fetch(url, { method, headers: h, body: json !== undefined ? JSON.stringify(json) : body, redirect });
}

const api = (method, path, opts = {}) => call(method, `/api/v1${path}`, { ...opts, headers: { ...auth, ...(opts.headers ?? {}) } });

// --- SPA + health ----------------------------------------------------------
{
  const r = await call("GET", "/");
  const html = await r.text();
  check("SPA shell served at /", r.status === 200 && html.includes('<div id="root"'), `HTTP ${r.status}`);
  const deep = await call("GET", "/analytics");
  check("SPA deep link falls back to index.html", deep.status === 200 && (await deep.text()).includes('<div id="root"'));
  const h = await call("GET", "/health");
  const hj = await h.json();
  check("health: database connected", hj.status === "healthy", JSON.stringify(hj));
}

// --- Tracked link + redirect + analytics -----------------------------------
let linkId;
{
  const r = await api("POST", "/utm/generate", {
    json: { base_url: "https://example.com/landing?ref=x", utm_source: "e2e", utm_medium: "smoke", utm_campaign: "cf-migration" },
  });
  const j = await r.json();
  check("generate tracked link", r.status === 200 && !!j.short_code, `HTTP ${r.status} ${JSON.stringify(j).slice(0, 160)}`);
  linkId = j.link_id;
  if (j.short_code) {
    const red = await call("GET", `/r/${j.short_code}`, { headers: { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1" } });
    const loc = red.headers.get("location") ?? "";
    check("/r/{code} redirects to the UTM-tagged URL", [301, 302, 303, 307].includes(red.status) && loc.includes("utm_source=e2e"), `HTTP ${red.status} -> ${loc}`);
    const s = await call("GET", `/s/${j.short_code}`);
    check("/s/{code} alias redirects", [301, 302, 303, 307].includes(s.status));
    // Click recording happens before the redirect response; give background geo a moment.
    await new Promise((res) => setTimeout(res, 1000));
    const links = await api("GET", "/utm/analytics/links?days=7");
    const lj = await links.json();
    const row = Array.isArray(lj) ? lj.find((l) => l.link_id === j.link_id || l.id === j.link_id || l.short_code === j.short_code) : null;
    check("click counted in link analytics", !!row && (row.click_count ?? row.total_clicks ?? row.clicks ?? 0) >= 1, row ? JSON.stringify(row).slice(0, 160) : `HTTP ${links.status}`);
    const ov = await api("GET", "/utm/analytics/overview?days=7");
    check("analytics overview responds", ov.status === 200, `HTTP ${ov.status}`);
    const geo = await api("GET", "/utm/analytics/geo?days=7");
    check("geo analytics responds", geo.status === 200, `HTTP ${geo.status}`);
  }
  const unknown = await call("GET", "/r/zzzzzzzzzz");
  check("unknown short code is 404", unknown.status === 404, `HTTP ${unknown.status}`);
}

// --- File upload + serve (incl. Range) -------------------------------------
let fileId;
{
  const bytes = new TextEncoder().encode("%PDF-1.4\n% champbeam e2e smoke\n" + "x".repeat(4096));
  const init = await api("POST", "/files", { json: { filename: "smoke.pdf", content_type: "application/pdf", size_bytes: bytes.length } });
  const ij = await init.json();
  check("file upload intent", (init.status === 200 || init.status === 201) && !!ij.file_id, `HTTP ${init.status} ${JSON.stringify(ij).slice(0, 160)}`);
  fileId = ij.file_id;
  if (ij.file_id) {
    const target = ij.upload_via_backend ? `${base}${ij.presigned_put_url}` : ij.presigned_put_url;
    const put = await fetch(target, { method: "PUT", headers: ij.headers ?? { "Content-Type": "application/pdf" }, body: bytes });
    check("blob PUT accepted", put.status >= 200 && put.status < 300, `HTTP ${put.status} via_backend=${ij.upload_via_backend}`);
    const fin = await api("POST", `/files/${ij.file_id}/finalize`, { json: {} });
    const fj = await fin.json();
    check("finalize -> active", fin.status === 200 && fj.status === "active", `HTTP ${fin.status} ${JSON.stringify(fj).slice(0, 160)}`);
    const serve = await call("GET", `/f/${ij.short_code}`, { redirect: "follow" });
    const served = new Uint8Array(await serve.arrayBuffer());
    check("/f/{code} serves the uploaded bytes", serve.status === 200 && served.length === bytes.length, `HTTP ${serve.status} len=${served.length}`);
    const ranged = await call("GET", `/f/${ij.short_code}`, { headers: { Range: "bytes=0-7" }, redirect: "follow" });
    const rb = new Uint8Array(await ranged.arrayBuffer());
    check("Range request returns 206 partial content", ranged.status === 206 && rb.length === 8, `HTTP ${ranged.status} len=${rb.length}`);
    const status = await api("GET", `/files/${ij.file_id}/status`);
    const sj = await status.json();
    check("file view counted", status.status === 200 && (sj.view_count ?? 0) >= 1, JSON.stringify(sj).slice(0, 160));
  }
}

// --- Beam Page publish + serve ---------------------------------------------
let pageId;
{
  const slug = `e2e-smoke-${Date.now().toString(36)}`;
  const pub = await api("POST", "/pages", {
    json: { html: "<!doctype html><html><head><title>Smoke</title></head><body><h1>Hello from Cloudflare</h1></body></html>", title: "Smoke", slug },
  });
  const pj = await pub.json();
  check("publish Beam Page", (pub.status === 200 || pub.status === 201) && !!pj.page_id, `HTTP ${pub.status} ${JSON.stringify(pj).slice(0, 160)}`);
  pageId = pj.page_id;
  if (pj.slug) {
    const page = await call("GET", `/p/${pj.slug}`);
    const html = await page.text();
    check("/p/{slug} serves the page", page.status === 200 && html.includes("Hello from Cloudflare"), `HTTP ${page.status}`);
    check("tracking snippet injected", /<script/i.test(html) && html.length > 120);
  }
}

// --- Projects ---------------------------------------------------------------
{
  const c = await api("POST", "/projects", { json: { name: "e2e smoke project", description: "temp" } });
  const cj = await c.json();
  check("create project", (c.status === 200 || c.status === 201) && !!cj.id, `HTTP ${c.status}`);
  const l = await api("GET", "/projects");
  check("list projects", l.status === 200 && (await l.json()).some((p) => p.id === cj.id));
  if (cj.id) check("delete project", [200, 204].includes((await api("DELETE", `/projects/${cj.id}`)).status));
}

// --- Cleanup ----------------------------------------------------------------
if (linkId) await api("DELETE", `/utm/links/${linkId}`);
if (fileId) await api("DELETE", `/files/${fileId}`);
if (pageId) await api("DELETE", `/pages/${pageId}`);

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
