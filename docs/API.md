# ChampBeam API — integration quickstart

Connect any application to ChampBeam and send **trackable short links** (with QR codes and hosted files) from inside it — under the platform domain or your own custom domain — then read the click analytics back.

Full request-by-request documentation lives in the Postman collection: [`docs/postman/ChampBeam.postman_collection.json`](postman/ChampBeam.postman_collection.json) (import it together with an environment file from the same folder). Interactive OpenAPI docs are served by the backend at `/docs`.

## 1. Get an API key

In the ChampBeam app: **Settings → API keys → Create key**. The full key (`cb_live_...`) is shown **once** — store it in your secret manager.

Send it on every request:

```
X-API-Key: cb_live_...
```

(`Authorization: Bearer cb_live_...` also works.) The key acts as your user: links it creates belong to your account, use your domains, and appear in your dashboard. Keys can be revoked instantly from the same Settings page. Key **management** is deliberately excluded from key auth — a leaked key cannot mint or revoke keys.

## 2. Create a trackable link

```bash
curl -s -X POST "$BASE/api/v1/utm/generate" \
  -H "X-API-Key: $CHAMPBEAM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "base_url": "https://example.com/creative-plan",
    "utm_source": "agent-workspace",
    "utm_medium": "api",
    "utm_campaign": "q3-outreach"
  }'
```

Response (the fields you care about):

```json
{
  "short_url": "https://share.lakeb2b.com/s/Ab3dEfG",
  "redirect_url": "https://share.lakeb2b.com/r/Ab3dEfG",
  "tracked_url": "https://example.com/creative-plan?utm_source=agent-workspace&...",
  "short_code": "Ab3dEfG",
  "link_id": "0b0e...-uuid"
}
```

Share `short_url`. Every visit records geo (city/country), device, referrer and UTM attribution. **Idempotent:** posting the identical URL + UTM set + domain again returns the existing link, so retries are safe.

Need a QR code? `GET /api/v1/qr.svg?data=<short_url>` (no auth) renders an SVG that scans straight into the tracked link.

## 3. Bring your own domain

1. `POST /api/v1/domains` `{"hostname": "links.acme.com"}` → domain is `pending_cname`.
2. Read `cname_target` from `GET /api/v1/domains/config` and create a DNS **CNAME** record: `links.acme.com → <cname_target>`.
3. ChampBeam re-checks every minute: once DNS resolves it issues the SSL certificate automatically and the domain flips to `active` (typically under 2 minutes; `POST /api/v1/domains/{id}/refresh` re-checks on demand).
4. Generate links with `"domain_id": "<that domain's id>"` — the returned `short_url` is `https://links.acme.com/s/...`. Set the domain primary and it becomes the default for links that don't pass any `domain_id`.

## 4. Host a file behind a trackable link

Three steps (see the Postman "Files" folder for a runnable chain):

```text
POST /api/v1/files                      {filename, content_type, size_bytes[, domain_id]}
  -> {file_id, presigned_put_url, ...}
PUT  <presigned_put_url>                 raw bytes, same Content-Type, no auth header
POST /api/v1/files/{file_id}/finalize    {}
  -> {serve_url: "https://<host>/f/<code>", ...}
```

File views are tracked like clicks, including per-page reading time for documents. Files and links share the same access controls (`PUT .../access`): expiry, view caps, email gate (captured leads via `.../leads`), VPN blocking, instant revoke.

**Update in place:** `PUT /api/v1/files/{file_id}/content` with the new bytes as the raw body (correct `Content-Type` header, optional `?filename=`) replaces the content while keeping the same `short_code`, serve URL and QR code — links you already sent now serve the new version, atomically, with view history preserved.

**Hosted HTML pages:** single-file HTML uploads are served inline with inline `<script>`/`<style>` and `localStorage` fully working (nothing is injected or sanitized; a CSP restricts external calls to same-origin + Google Fonts). Combined with update-in-place, this makes shareable, revisable, view-tracked dashboards/pages a first-class use case.

## 5. Read analytics

| What | Endpoint |
|---|---|
| Account overview | `GET /api/v1/utm/analytics/overview?days=30` |
| All links + performance | `GET /api/v1/utm/analytics/links` |
| One link's click stream | `GET /api/v1/utm/analytics/links/{link_id}/events` |
| One link's geo / devices | `GET .../links/{link_id}/geo`, `.../devices` |
| Campaign rollups | `GET /api/v1/utm/analytics/campaigns` |
| Near-real-time feed | `GET /api/v1/utm/analytics/clicks/recent?since=<iso>` |
| CSV export | `GET /api/v1/utm/analytics/export/events` |

## Pages: hosted, tracked HTML pages (Beam Pages)

Publish a single-file HTML page (a checklist, dashboard, proposal microsite) behind a **permanent trackable link** — one call, no upload dance:

```bash
curl -s -X POST "$BASE/api/v1/pages" \
  -H "X-API-Key: $CHAMPBEAM_API_KEY" -H "Content-Type: application/json" \
  -d '{"title": "Pallab North Star", "html": "<!doctype html>…", "slug": "pallab-northstar"}'
# -> {"page_id": "...", "slug": "pallab-northstar", "url": "https://<host>/p/pallab-northstar", "legacy_url": "https://<host>/f/<code>", ...}
```

Or upload the file: `POST /api/v1/pages/upload` (multipart `file`, optional `title`, `slug`, `domain_id`).

**Serving.** Pages live at `/p/{slug}` (readable, editable) and also at their `/f/{code}` legacy URL; on a custom domain, at that hostname. The stored file is served **byte-identical** — inline `<script>`, `<style>` and `localStorage` work untouched (CSP allows inline code and Google Fonts; other external calls are blocked). A tracking snippet is injected into `<head>` *per response*, never into the stored bytes.

**What is recorded per open:** geo (city/region/country), device, browser, referrer, ISP/VPN flag, a first-party visitor id, whether the open is a **revisit** (same visitor after 30 minutes), and **dwell** (visible time, reported every 15 s and on hide). Read it back with `GET /api/v1/pages/{id}/analytics` (views, unique visitors, revisits, total/median/avg dwell) and `GET /api/v1/pages/{id}/events` (merged timeline: `view`, `revisit`, `comment_added`, `state_changed`, `gate_failed`).

**Update in place.** `PUT /api/v1/pages/{id}` `{"html": "..."}` swaps the content atomically; the URL, slug and QR never change and view history is kept. Every publish/update is retained as a version: `GET /api/v1/pages/{id}/versions`, `POST /api/v1/pages/{id}/versions/{n}/rollback` (the rollback is itself a new version, so history stays linear). The last 10 versions are kept.

**Settings.** `PATCH /api/v1/pages/{id}` with any of `slug` (3–60 chars, lowercase/digits/hyphens; 409 if taken), `title`, `enabled` (`false` = kill switch: every URL and API route returns 410 immediately), `domain_id`, `access_code` (4–8 digits; `null` clears). `DELETE` removes the page and every version blob.

**Guardrails.** 2 MB cap. Rejected with a clear reason: server-side extensions (`.php`, `.asp`, `.jsp`, …), non-`text/html` content types, and files containing `<?php` or `<%` (the latter can false-positive on client-side templates — rename the delimiter).

**Access codes.** With `access_code` set, visitors see a branded code gate *before* any email gate (authorize before identify). 5 wrong attempts per 10 minutes → a 429 "too many attempts" page; each failure is a `gate_failed` event. The code cookie is derived from the code, so changing the code re-gates everyone.

### Beam State: comments + shared state for pages

Simple interactive pages (checklists, boards, sign-offs) need zero external backend. The served page gets a **page-scoped public token** and a helper on `window.beam`:

```js
// inside your page — no fetch boilerplate needed
await window.beam.state.set('check:step-1', { done: true, by: 'Sonali' });
const all = await window.beam.state.all();            // {"check:step-1": {...}}
await window.beam.comments.add('Deep', 'Looks good.'); // append-only
const { comments } = await window.beam.comments.list(); // ascending; pass a comment id to `list(afterId)`
const stop = window.beam.poll(8000, (state, comments) => render(state, comments)); // no websockets; 5–10 s is right
```

Under the hood: `GET/POST /api/pages/{slug}/comments`, `GET/PUT/DELETE /api/pages/{slug}/state[/{key}]` with an `X-Beam-Token` header. Same-origin with the page on every host, so it works on custom domains. Limits: 4000-char comments, 16 KB values, 200 keys and 5000 comments per page, 30 writes/min per visitor. The token only ever addresses its own page; rotate it with `POST /api/v1/pages/{id}/state-token/rotate`. When a page is disabled, every state route returns 410 (`window.beam.dead` flips to `true`). Owners moderate via `GET/DELETE /api/v1/pages/{id}/comments[/{cid}]` and `GET/DELETE /api/v1/pages/{id}/state[/{key}]`.

It is a JSON store with a comment stream, not a database: no queries, no per-user auth, no schemas. A page needing more brings its own backend (its own API origin must then be allowed for that page's CSP — ask before relying on it).

## Service keys (trusted backend integrations)

Separate from user API keys: a **service key** (`X-Service-Key` header, provisioned via the `SERVICE_API_KEYS` env, e.g. for the agent workspace) resolves to a dedicated org-scoped service identity and is accepted **only** on a write allowlist — register content (`POST /content`), mint shares (`POST /content/{id}/share`), generate links (`POST /utm/generate`), and publish/update pages. Any other route returns 403; reads are never allowed. 60 requests/minute per key. See `app/core/service_auth.py`.

## Limits & errors

- **429** — over the per-key limit (120 requests/minute) or the per-IP limit (100/minute). Back off and retry.
- **401** — missing/invalid/revoked key. A bad key never falls back to anonymous behavior.
- **403** — the endpoint needs an interactive session (key management, org features).
- **404 "Active domain not found"** — the `domain_id` isn't yours or isn't `active` yet.

## Validating the collection (maintainers)

```bash
newman run docs/postman/ChampBeam.postman_collection.json \
  -e docs/postman/ChampBeam.deepify.postman_environment.json \
  --env-var api_key=cb_live_...
```

Requests that need optional context (an active custom domain, a Clerk session token, a CSV file) skip themselves when their variable is unset.
