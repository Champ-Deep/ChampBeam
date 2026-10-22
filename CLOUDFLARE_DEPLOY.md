# ChampBeam on Cloudflare

On the `cloudflare` branch, the whole app runs on Cloudflare as **one Worker**:

| Piece | Before | On Cloudflare |
|---|---|---|
| Frontend (React SPA) | Vercel | Worker **static assets** (`frontend/dist`) |
| API, short links `/r` `/s`, files `/f`, pages `/p` | FastAPI on Railway / DigitalOcean | Worker (`worker/`, Hono + TypeScript) |
| Database | Postgres | **D1** (`worker/migrations/`) |
| File bytes | Mongo GridFS / disk / S3 | **R2** |
| Rate-limit counters | Redis | D1 table `rate_counters` |
| Geo / ASN for clicks | MaxMind `.mmdb` + ip-api | `request.cf` on every request (MaxMind web service / IPinfo optional) |
| Background loops | asyncio tasks | **Cron Triggers** (`*/15`, `*/5`) |
| Custom domains | VPS nginx + certbot | **Cloudflare for SaaS** custom hostnames |

Static assets are served without invoking the Worker; only `/api/*`, `/r/*`,
`/s/*`, `/f/*`, `/p/*` and `/health` run code (`run_worker_first` in
`worker/wrangler.jsonc`). Because the SPA and API share an origin, the frontend
needs no `VITE_API_URL` — production builds default to `/api/v1`.

## 1. One-time setup

Requires a Cloudflare account on the **Workers Paid** plan (cron, D1/CPU
headroom), Node 20+, and `npx wrangler login`.

```bash
cd worker
npm ci

# D1 database — paste the printed database_id into wrangler.jsonc
npx wrangler d1 create champbeam
npx wrangler d1 migrations apply champbeam --remote

# R2 bucket for file bytes
npx wrangler r2 bucket create champbeam-files
```

### Secrets
```bash
npx wrangler secret put CLERK_SECRET_KEY          # sk_live_...
npx wrangler secret put CLERK_WEBHOOK_SECRET      # whsec_... (Clerk webhook)
npx wrangler secret put STORAGE_UPLOAD_SECRET     # long random string
# optional, as used before:
npx wrangler secret put SERVICE_API_KEYS          # name:key,...
npx wrangler secret put CHAMPVAULT_API_KEY
npx wrangler secret put CLOUDFLARE_API_TOKEN      # custom hostnames / registrar
npx wrangler secret put MAXMIND_LICENSE_KEY       # only for the MaxMind web service
npx wrangler secret put IPINFO_API_TOKEN
# optional: direct browser<->R2 uploads (no 100 MB Worker body limit)
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
```

Plain settings live under `vars` in `wrangler.jsonc` (`FRONTEND_URL`,
`REDIRECT_BASE_URL`, `PLATFORM_REDIRECT_HOST`, `CLERK_PUBLISHABLE_KEY`,
`CHAMPVAULT_URL`, `CLOUDFLARE_ZONE_ID`, `CLOUDFLARE_CNAME_TARGET`,
`R2_ACCOUNT_ID`, …). Every name matches the old backend env var.

### Large uploads
Without R2 API credentials, uploads stream through the Worker, which caps a
request body at 100 MB on Free/Pro plans. For bigger videos, create an R2 API
token (Object Read & Write) and set `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`: the browser then uploads straight to R2 with presigned
URLs. Add a CORS rule on the bucket allowing `PUT` from the app origin.

## 2. Build and deploy

```bash
cd worker
VITE_CLERK_PUBLISHABLE_KEY=pk_live_... npm run deploy   # builds frontend/, then wrangler deploy
```

Or connect the repo in **Workers Builds** (Cloudflare dashboard): root
directory `worker`, build command `npm run build:frontend`, deploy command
`npx wrangler deploy`, and `VITE_CLERK_PUBLISHABLE_KEY` as a build variable.

## 3. Domains

- **App**: Workers → champbeam → Settings → Domains → add `www.champbeam.com`
  (and `champbeam.com`). The zone must be on Cloudflare.
- **Share host** (`share.lakeb2b.com`): it already proxies through Cloudflare
  (IT's `lakeb2b.com` zone). Either deploy the Worker in that account and add
  it as a Custom Domain, or keep it in your account and attach the hostname
  through Cloudflare for SaaS. Rollback = remove the route; traffic goes back
  to the old origin.
- Set `PLATFORM_REDIRECT_HOST` to every host that has ever minted links
  (`share.lakeb2b.com,champutm-production.up.railway.app,...`) so old links keep
  resolving.
- Customer custom domains use Cloudflare for SaaS (`CLOUDFLARE_*` vars).

## 4. Moving the data (one time)

Run from a machine with the backend's Python deps (`pip install -r requirements.txt`).

```bash
# Rows: Postgres -> D1
python worker/scripts/export_postgres_to_d1.py "$DATABASE_URL" --out d1-export
for f in d1-export/*.sql; do npx wrangler d1 execute champbeam --remote --file "$f"; done

# File bytes -> R2 (GridFS on Railway shown; also --source s3 | local)
R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... R2_BUCKET_NAME=champbeam-files \
MONGO_URL=... python worker/scripts/copy_blobs_to_r2.py --database-url "$DATABASE_URL" --source mongo
```

Do a full run first to rehearse, then a final run right before switching DNS.
The row export expects an empty D1 database, so reset it before the final
import (`wrangler d1 delete` + `create` + `migrations apply`). The blob copy
skips objects already in R2, so it is safe to re-run.

## 5. Local development

```bash
cd worker
cp .dev.vars.example .dev.vars        # fill in local secrets
npm run db:migrate:local
npm --prefix ../frontend run build    # or run Vite separately (below)
npx wrangler dev                      # http://localhost:8787 serves SPA + API
```

For frontend hot reload, run `npm --prefix frontend run dev` with
`VITE_API_URL=http://localhost:8787` in `frontend/.env.local`.

`PLATFORM_REDIRECT_HOST` must list every host that serves share links
(`/r`, `/s`, `/f`, `/p`). Any other host is treated as a customer custom
domain and refused unless it is registered and active — the same rule as the
Python app.

## 6. Verifying

- **Unit/route tests** — `cd worker && npm test`: 379 tests in workerd against
  an in-memory D1 + R2, ported from `backend/tests` plus new coverage.
- **End to end, locally** — `cd worker && bash scripts/e2e-local.sh`: fresh
  local D1, builds the SPA, starts `wrangler dev` on port 8799, seeds a user +
  API key, then drives the SPA shell, link generate → `/r` redirect → click
  analytics, file upload → R2 → `/f` serve (incl. Range), Beam Page publish →
  `/p` serve, and projects.
- **Against a deployment** — `node worker/scripts/e2e-smoke.mjs https://<host> cb_live_<key>`
  (creates and then deletes its own link, file, page and project).

## 7. Behaviour differences from the FastAPI app

Paths, status codes and response shapes are unchanged; the SPA needed only the
same-origin API default. Deliberate differences:

- **Geo** comes from Cloudflare (`request.cf`) instead of MaxMind `.mmdb` files;
  the MaxMind web service (VPN/anonymizer flags) and IPinfo still apply when
  configured. ip-api.com is dropped. User-agent parsing uses `ua-parser-js`,
  matched to the Python output (61 of 63 sample agents identical).
- **Range requests** on `/f` now return 206 (video seeking); seeks after byte 0
  don't count as new views. HEAD is answered on `/f` and `/p`.
- **Atomicity**: D1 has no interactive transactions. Multi-row writes use
  atomic batches; click/view counters use atomic SQL increments (more accurate
  than before under concurrency). A Clerk webhook that fails halfway can leave
  earlier rows written (it still reports `{ok:false}`).
- **Background loops are cron jobs**: domain status refresh every 5 minutes
  (was every minute), expired-upload sweep every 15.
- **Uploads through the Worker** are capped at 100 MB (plan limit) unless R2
  presigned uploads are configured (section 1).
- **Malformed IDs** that crashed some Python endpoints with a 500 now return a
  clean 400/404/422.
- **Timestamps** are stored with millisecond (not microsecond) precision.
