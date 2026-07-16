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

**Symptom.** The deploy (not the build) crashes on the FIRST start step with a
full traceback ending in
`asyncpg.exceptions.InvalidPasswordError: password authentication failed for user "postgres"`,
repeated every ~1s (that's Railway restarting the crashed container). uvicorn
never binds, so the healthcheck times out.

**This is a database credential problem, not a code bug.** The connection
*reached* Postgres and was rejected at auth — so the host/port/scheme are all
correct and `DATABASE_URL` is being read (the app's default DB user is
`champbeam`; seeing user `postgres` means `DATABASE_URL` is present and carries
`user=postgres`). Only the **password** is wrong. `bootstrap_db.py` prints the
redacted target (`connecting to Postgres: user=… host=… db=…`, password never
logged — CFG-8) right before it connects, and fails fast on auth (CFG-7) rather
than stalling. Nothing in the app can fix a password the database itself
rejects.

**Why it "deployed fine before."** The code path is unchanged; the DB
credentials drifted since the last good deploy. Three common triggers:

1. **Volume-baked password (the classic Railway trap).** Postgres only applies
   `POSTGRES_PASSWORD` when it *first initializes an empty data volume*. If that
   variable was changed afterward, Railway's UI and the generated `DATABASE_URL`
   show the NEW password, but the running role still authenticates with the
   ORIGINAL one stored in the volume. Comparing the backend's `DATABASE_URL` to
   the Postgres service's `DATABASE_URL` just compares two copies of the same new
   (wrong) value — they'll look identical and still be rejected.
2. A **hardcoded** `DATABASE_URL` literal that went stale after the DB was
   recreated/restored or credentials were rotated.
3. The `DATABASE_URL` reference points at a **different Postgres service** than
   the one whose password you're checking.

**Fix — make the password the DB actually expects match `DATABASE_URL`:**

- **Reset the Postgres role's password to a known value** (Postgres service →
  *Data*/*Query* tab, or `psql`): `ALTER USER postgres WITH PASSWORD 'newpw';`
  then set that same value in the variables. This is the only fix that works
  when the password is baked into the volume (case 1) — changing the variable
  alone won't touch the role.
- **Or** reference the credentials so they can't drift again (best once the
  role password and the service variable agree): Backend service → **Variables**
  → set `DATABASE_URL` to a reference to the Postgres service (replace `Postgres`
  with its actual name):
  - Preferred (internal networking, no egress cost/latency):
    `DATABASE_URL=${{Postgres.DATABASE_PRIVATE_URL}}`
  - Or public: `DATABASE_URL=${{Postgres.DATABASE_URL}}`
  Remove any stale hardcoded value, then redeploy.
- **To confirm which case you're in:** open the deploy log and read the
  `connecting to Postgres: user=… host=… db=…` line. If the host/user/db are the
  ones you expect, it's purely the password — reset the role (above). If the host
  is a *default* (e.g. `localhost`) or the user is `champbeam`, `DATABASE_URL`
  isn't reaching the container and it's falling back to discrete vars — fix the
  variable/reference instead.

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
