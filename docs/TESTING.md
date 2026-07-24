# Champbeam — Canonical Test Suite

This is the **single source of truth** for how Champbeam is verified. Every
behaviour we care about — location/geo, analytics, the App v2 themes, the login
flow, and page performance — has a test ID here. Going forward we **keep to these
tests**: a change ships only when the suite below is green, and new behaviour is
added by adding a test ID here (not by ad‑hoc manual checks).

Three layers, each runnable on its own:

| Layer | Runner | Location | Needs a deployment? |
|-------|--------|----------|---------------------|
| Backend unit/integration | `pytest` | `backend/tests/` | No (in‑memory SQLite) |
| Frontend unit/component | `vitest` | `frontend/src/**/*.test.tsx` | No (jsdom) |
| End‑to‑end (browser + API) | `playwright` | `frontend/e2e/` | Yes (Railway API + Vercel frontend) |

---

## How to run everything

```bash
# 1) Backend — 62 tests, no services required
cd backend && python -m pytest -q

# 2) Frontend unit/component — themes + picker, jsdom
cd frontend && npm run test

# 3) End-to-end against the deployed TEST instance
cd frontend
export E2E_BASE_URL="https://<frontend-origin>"          # Vercel test URL
export E2E_API_URL="https://<railway-app>/api/v1"        # Railway backend /api/v1
npm run test:e2e                                         # public specs run; authed self-skip

# 3b) To also run the signed-in specs, capture a Clerk session once:
npx playwright open --save-storage=auth.json "$E2E_BASE_URL/sign-in"   # sign in, then close
E2E_STORAGE_STATE=auth.json npm run test:e2e
```

E2E specs **self-skip** when the env var they need is unset, so a bare run never
fails for missing config — it reports what it could and couldn't verify.

> The pre-installed Chromium is used automatically
> (`playwright.config.ts` → `executablePath: /opt/pw-browsers/chromium`).
> Do not run `playwright install`.

---

## Test matrix

### API deployment — `frontend/e2e/api-smoke.spec.ts` (needs `E2E_API_URL`)
Proves the backend build actually shipped the geo/analytics/vault routes. A `404`
here is the regression that silently broke the last deploy.

| ID | Proves |
|----|--------|
| API-1 | `/health` returns 200. |
| API-2 | `GET /utm/analytics/geo` is deployed (200 or auth challenge, **never 404**). |
| API-3 | `GET /utm/analytics/company-intent` is deployed (never 404). |
| API-4 | `GET /champvault/config` returns a `configured: boolean`. |

### Login — `frontend/e2e/app-smoke.spec.ts` (needs `E2E_BASE_URL`)
The login-loop regression: a 401 must **not** bounce the browser between
`/sign-in` and a protected route forever.

| ID | Proves |
|----|--------|
| LOGIN-1 | Visiting `/links` signed-out lands on `/sign-in` and the URL **stays put** (no loop); a Clerk sign-in surface renders (not blank). |
| LOGIN-2 | The landing page loads with **no uncaught console/runtime errors**. |

### Auth / Clerk token verification — backend (`test_clerk_security.py`)
Guards the authorized-party (`azp`) check that gates every authenticated request.
A blanket 401 across all endpoints is usually a frontend↔backend Clerk mismatch —
see **docs/DEPLOY-TROUBLESHOOTING.md**.

| ID | Proves |
|----|--------|
| AUTH-1 | An `azp` origin in the strict allowlist (CLERK_AUTHORIZED_PARTIES / FRONTEND_URL / CORS_ALLOW_ORIGINS) authorizes; an unlisted one does not. |
| AUTH-2 | A per-deploy Vercel **preview** origin still authenticates when it matches `CORS_ALLOW_ORIGIN_REGEX` (so previews don't 401 with "Unauthorized party"). |
| AUTH-3 | With no regex configured, only the exact allowlist authorizes (strict, unchanged). |

### Performance / no stutter — `frontend/e2e/app-smoke.spec.ts`, `authed.spec.ts`

| ID | Proves |
|----|--------|
| PERF-1 | Landing does not reload in a loop (< 4 main-frame navigations over 3 s). |
| PERF-2 | Signed-in route changes are client-side pushState (no full-page stutter across two visits). |

### Themes — unit (`useTheme.test.ts`, `AppearanceSettings.test.tsx`) + E2E
The App v2 theme system: Paper default, five palettes, live switch, persistence.

| ID | Type | Proves |
|----|------|--------|
| THM-1 | unit | All five themes exist (`paper, graphite, lagoon, merlot, slate`), Paper first. |
| THM-2 | unit | The picker surfaces exactly Paper / Graphite / Lagoon. |
| THM-3 | unit | `applyTheme` stamps `data-cb-theme` on `<html>`. |
| THM-4 | unit | Defaults to Paper when nothing is stored. |
| THM-5 | unit | `setTheme` persists to `localStorage` **and** applies it. |
| THM-6 | unit | A persisted theme is restored on remount (survives reload). |
| THM-7 | unit | A corrupt stored value falls back to Paper (no crash). |
| THM-8 | unit | Every theme id round-trips through the attribute. |
| THM-9 | unit | The Appearance panel renders Paper/Graphite/Lagoon cards + the "default" tag. |
| THM-10 | unit | Clicking a card applies + persists that theme. |
| THM-E1 | e2e | **First paint** is the Paper theme in a real browser. |
| THM-E2 | e2e | A persisted theme is applied on load **and the `--cb-accent` token actually changes** (Graphite → `#2f3437`). |
| THM-A1 | e2e (authed) | Settings → Appearance switch applies + survives a reload. |

### Location / geo — backend (`test_geoip_ipinfo.py`, `test_opens_geo.py`) + E2E
See **Verifying location end-to-end** below — the backend tests prove the code,
but a live "Unknown → real city" check needs `IPINFO_API_TOKEN` set on the server.

| ID | Type | Proves |
|----|------|--------|
| GEO-1 | backend | IPinfo path returns country/region/city/lat-lng + ISP with the AS number stripped. |
| GEO-2 | backend | Geo lookup returns `is_vpn` from the privacy dataset / hosting ASN. |
| GEO-3 | backend | No `IPINFO_API_TOKEN` → IPinfo path is skipped (no crash, falls back). |
| GEO-4 | backend | Private/loopback IPs short-circuit (no external call). |
| GEO-5 | backend | `GET /utm/analytics/geo` aggregates opens into countries/cities/by-day. |
| GEO-6 | backend | MaxMind GeoIP2 web service (Insights) parses geo + ISP + `is_vpn` from anonymizer traits; account id is passed as an int. |
| GEO-7 | backend | No MaxMind account id **or** license key → web-service path skipped (no call). |
| GEO-8 | backend | With no local DB, `lookup_ip` prefers MaxMind web service over IPinfo/ip-api. |
| GEO-9 | backend | City endpoint (no anonymizer flags) infers `is_vpn` from the hosting ASN owner. |
| GEO-10 | backend | `ensure_geoip` skips the local-DB download when the MaxMind web service is configured (so boot isn't delayed → no healthcheck timeout). |
| GEO-11 | backend | `ensure_geoip` skips the download when IPinfo is configured. |
| GEO-12 | backend | `GEOIP_FORCE_DOWNLOAD=1` overrides the skip and attempts the download. |
| LOCATION-1 | e2e (authed) | A link's analytics view exposes a location/geo section. |

### Analytics — backend (`test_opens_geo.py`, `test_company_intent.py`) + E2E

| ID | Type | Proves |
|----|------|--------|
| ANL-1 | backend | Opens roll up into the geo analytics payload (countries/cities/by_day). |
| ANL-2 | backend | Company-intent classifies opens into Hot / Warm / Cool by reverse-IP. |
| ANALYTICS-1 | e2e (authed) | The Analytics page renders without runtime errors. |

### Navigation / layout — `frontend/e2e/authed.spec.ts`

| ID | Proves |
|----|--------|
| NAV-1 | The dark sidebar + orbit wordmark render after sign-in. |
| CHIPS-1 | Links and Files show the folder **chips** row (App v2), not the old rail. |

### Content library ↔ ChampVault — backend (`test_champvault_library.py`)
The admin curates the library directly from ChampVault; picked assets become live
references the whole team can share (each share re-mints a fresh delivery URL).

| ID | Proves |
|----|--------|
| CVLIB-1 | An admin adds a ChampVault asset to the library (title resolved from ChampVault, `champvault_asset_id` surfaced); it's idempotent per (org, asset), shows in `/content`, and a member share of it re-mints a fresh delivery URL on open. |
| CVLIB-2 | An explicit title skips the ChampVault lookup; a non-admin member is forbidden (403) from adding to the library. |

### Briefing Rooms + visit tracking — backend (`test_rooms.py`)
Hosted Briefing Rooms (spec Modules B & C), Slice 1 spine: rooms assembled from
ChampVault assets, per-recipient tokenized links, identified event tracking, and
the self-ranking engagement score. See **docs/BRIEFING-ROOMS.md**.

| ID | Proves |
|----|--------|
| ROOM-1 | A rep creates a draft room (unique slug, assets stored) and publishes it. |
| ROOM-2 | Each recipient gets a unique tokenized link (`/rooms/{slug}?t={token}`). |
| ROOM-3 | Public resolve renders per-recipient personalization with a valid token; stays anonymous ("your team") without one. |
| ROOM-4 | A draft room is 404 publicly; an archived room resolves with `ended=true` (branded "briefing has ended", never a 404). |
| ROOM-5 | Identified events ingest against the recipient and roll into the engagement score (video 30 + return 20 + cta 20 + dwell 10 = 80). |
| ROOM-6 | A tokenless event is recorded anonymously (forwarded/unknown viewer) and surfaced as a signal, not attributed to a recipient. |
| ROOM-7 | An unknown event type is 400; tracking against a missing room is 404. |

### Deploy / config — backend (`test_config_database_url.py`)
Guards the `DATABASE_URL` handling that has bitten deploys. See
**docs/DEPLOY-TROUBLESHOOTING.md** for the runbook.

| ID | Proves |
|----|--------|
| CFG-1 | `postgresql://…` is normalized to the asyncpg driver. |
| CFG-2 | `postgres://…` (Railway/Heroku shorthand) is normalized to asyncpg. |
| CFG-3 | An explicit `postgresql+asyncpg://…` is passed through unchanged. |
| CFG-4 | Surrounding whitespace (copy-paste) is trimmed. |
| CFG-5 | With no `DATABASE_URL`, the URL is built from discrete `POSTGRES_*` vars. |
| CFG-6 | `bootstrap_db.main()` retries a transient connect (DNS/connection race at cold start) and then succeeds (`test_bootstrap_retry.py`). |
| CFG-7 | A wrong-password auth error fails fast without retrying (no 20 s stall). |
| CFG-8 | The startup diagnostic logs the connection target (user/host/db) so an auth failure is diagnosable, but **never prints the password** (`test_bootstrap_retry.py`). |

---

## Verifying location end-to-end (the "Unknown" fix)

The screenshots that showed **Geo = Unknown / blank ISP** had two causes, both
fixed in the backend:

1. MaxMind was never installed, and the free ip-api.com fallback **blocks
   datacenter IPs** (Railway/any PaaS egress), so every async lookup returned
   nothing while the UA-parsed device/browser still showed.
2. The fix adds an **IPinfo path** (HTTPS, datacenter-safe) and wires
   `ensure_geoip.py` into boot.

**We are using MaxMind** (GeoIP Insights). Two ways to run it — pick one:

- **MaxMind web service / Insights (chosen)** — HTTPS REST, datacenter-safe, and
  returns anonymizer traits for VPN detection. Set on the backend:
  - `MAXMIND_ACCOUNT_ID` = your MaxMind account id
  - `MAXMIND_LICENSE_KEY` = the license key for that account
  - `MAXMIND_WS_HOST` = `geoip.maxmind.com` (default; use `geolite.info` for the
    free GeoLite2 web service)
  - `MAXMIND_WS_ENDPOINT` = `insights` (default; `city` is cheaper but has no
    VPN/anonymizer flags)
- **MaxMind local DB (free GeoLite2)** — set `MAXMIND_LICENSE_KEY` only; boot
  (`ensure_geoip.py`) downloads GeoLite2 City + ASN to a mounted volume.

Fallbacks remain available and need no MaxMind: `IPINFO_API_TOKEN`, then the free
ip-api.com. Provider order and the swap plan are in **docs/GEO-PROVIDERS.md**.

To confirm on a live instance:

1. Set the MaxMind vars above and redeploy.
2. Open a tracked link from a real network.
3. In the link/file analytics, the new open should show **country + city + ISP**,
   and VPN/proxy opens should be flagged. Historical opens stay "Unknown" — they
   were recorded before enrichment and are not backfilled.

Automated backing: **GEO-1..GEO-9** prove the resolvers (IPinfo + MaxMind web
service) and the endpoint; **API-2** proves the endpoint is deployed;
**LOCATION-1** proves the UI surfaces it.

---

## Regression policy

- **Green-before-merge.** All three layers must pass before merging to `main`.
  Backend + unit run anywhere; E2E runs against the test instance.
- **New behaviour ⇒ new test ID here.** Don't verify by hand and move on — add
  the case to this file and to the matching spec so it's checked forever.
- **Deleting a test** requires deleting its row here too, with a reason in the PR.
