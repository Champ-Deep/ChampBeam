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
