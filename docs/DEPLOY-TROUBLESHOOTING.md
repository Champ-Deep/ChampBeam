# Deploy troubleshooting

Boot order on Railway / any PaaS (see `Procfile` and `railway.toml`):

```
bootstrap_db.py  →  alembic upgrade head  →  ensure_geoip.py  →  uvicorn
```

If any step before `uvicorn` fails, the server never binds a port, `/health`
never responds, the healthcheck times out, and the platform rolls the deploy
back. So **a healthcheck timeout is almost always an earlier crash, not a slow
healthcheck** — read the deploy logs above the timeout line for the real error.

---

## Build fails at `alembic upgrade head` with `socket.gaierror: Name or service not known` (or a password error)

**Symptom.** The **build** (not the deploy) fails — a nixpacks `RUN` step
(`[stage-0 N/10] RUN cd backend && ... alembic upgrade head`) crashes with a DNS
error resolving the Postgres host, or "password authentication failed".

**Cause.** Migrations are running at **build time**, where there is **no
database network**. Railway's private DB host (`*.railway.internal`) doesn't
resolve during a build → `Name or service not known`; a public host may resolve
but then rejects credentials. The trigger is a **Procfile `release:` phase** —
Railway/nixpacks bakes it into the image build. Migrations must never run at
build.

**Fix.** Run migrations at **runtime**, not build:
- Remove any `release:` line from the `Procfile`. Migrations already run on start
  via `railway.toml`'s `startCommand` (and the Procfile `web:` line):
  `bootstrap_db.py && alembic upgrade head && ... && uvicorn`. Runtime has the DB
  network and the right credentials.
- If you want a dedicated migration step, use Railway's **Pre-deploy Command**
  service setting (runs at runtime with networking) — not a Procfile release.
- The `backend/Dockerfile` already does this correctly (migrations in `CMD`, not
  `RUN`), so non-Railway PaaS that build from it are unaffected.

---

## "password authentication failed for user postgres" → healthcheck timeout

**Cause.** `DATABASE_URL` carries a password that no longer matches the Postgres
service. `bootstrap_db.py` can't connect, migrations never run, uvicorn never
starts. This happens when `DATABASE_URL` is a **hardcoded literal** and the
database's password later changes (DB recreated/restored, service replaced, or
credentials rotated). The app scheme handling is fine — it connected far enough
to be rejected at auth.

**Fix (Railway).** Stop hardcoding; make `DATABASE_URL` a **reference** so it
always tracks the live database credentials:

1. Backend service → **Variables**.
2. Set `DATABASE_URL` to a reference to the Postgres service (replace `Postgres`
   with your DB service's actual name):
   - Preferred (internal networking, no egress cost/latency):
     `DATABASE_URL=${{Postgres.DATABASE_PRIVATE_URL}}`
   - Or public: `DATABASE_URL=${{Postgres.DATABASE_URL}}`
3. Remove any stale hardcoded `DATABASE_URL` value.
4. Redeploy.

A referenced value can never drift out of sync with the database again.

**Notes / gotchas.**
- The app normalizes the driver automatically: `postgres://` and
  `postgresql://` both become `postgresql+asyncpg://` (see `Settings.postgres_url`,
  tested by `CFG-1..5`). You do **not** need to hand-edit the scheme.
- asyncpg does not accept libpq's `?sslmode=...` in the DSN. Railway's internal
  URL has no such param — another reason to prefer `DATABASE_PRIVATE_URL`. If a
  URL includes `?sslmode=require`, strip it (TLS to Railway PG isn't required on
  the private network).
- To sanity-check locally without a redeploy, compare the password in your
  backend's `DATABASE_URL` against the Postgres service's **Connect** tab; they
  must match exactly.

**Verify after redeploy.** The API deployment smoke in the test suite catches a
healthy backend without needing a browser:

```bash
cd frontend
E2E_API_URL="https://<backend>/api/v1" npx playwright test api-smoke   # API-1..4
```

`API-1` (/health = 200) passing means bootstrap + migrations ran and the server
is up — i.e. the DB URL is correct.

---

## Migration failed: `StringDataRightTruncationError` on `alembic_version`

`alembic_version.version_num` is `VARCHAR(32)`. A revision id longer than 32
chars fails the stamp `UPDATE`, so `alembic upgrade head` crashes and the deploy
never starts. Keep every Alembic `revision` id ≤ 32 characters.

---

## Healthcheck times out right after setting a MaxMind key (build succeeds)

**Symptom.** The build passes, but the deploy's healthcheck times out — uvicorn
never binds. Started happening right after `MAXMIND_LICENSE_KEY` was set.

**Cause.** `ensure_geoip.py` runs on the start command **before uvicorn**. With a
license key set and no local `.mmdb` present (no mounted volume → always
"missing"), it downloads GeoLite2 City+ASN on every boot. A slow/hung MaxMind
endpoint could block for up to ~4 minutes, pushing uvicorn past the healthcheck
window. Before the key was set it was an instant no-op — which is why it
"deployed fine before".

**Fix (already in code).** `ensure_geoip` now **skips the download when a web geo
provider is configured** (`MAXMIND_ACCOUNT_ID` for the web service, or
`IPINFO_API_TOKEN`) — the common case, since Insights/IPinfo resolve over HTTPS
with no local DB — and the download timeout is capped (default 20s,
`GEOIP_DOWNLOAD_TIMEOUT`). Force local DBs anyway with `GEOIP_FORCE_DOWNLOAD=1`
(only useful with a mounted volume at `data/`). Guarded by GEO-10..12.

Note: `/health` always returns HTTP 200 (it reports DB status in the body but
never 500s), so a failing healthcheck means **uvicorn isn't binding** — look at
the start-command steps (bootstrap → alembic → ensure_geoip), not the app. And
ChampVault is never called at boot or in `/health`, so `CHAMPVAULT_*` cannot
cause a healthcheck failure.

---

## Geo shows "Unknown" after a successful deploy

The app is up but no geo provider is configured, or the only one configured is
ip-api.com (blocked from datacenter IPs). Set MaxMind or IPinfo — see
`docs/GEO-PROVIDERS.md`. Backed by `GEO-1..9` and `API-2`.
