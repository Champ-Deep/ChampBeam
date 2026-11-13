# ChampBeam on Cloudflare

This is production. https://champbeam.com is one Worker (`worker/`, wrangler name `champbeam`), deployed from `main` since the 6 Nov 2026 cutover (PR #58). The notes below match `worker/wrangler.jsonc`, `worker/src`, and `worker/package.json`.

| Piece | Production |
|---|---|
| React SPA | Worker static assets (`frontend/dist`) |
| API, `/r`, `/s`, `/f`, `/p`, `/health` | This Worker (Hono, TypeScript) |
| Database | D1 (`worker/migrations/`), Drizzle |
| File bytes | R2 binding `FILES` |
| Rate-limit counters | D1 table `rate_counters` |
| Geo | `request.cf`. MaxMind web service and IPinfo are optional. |
| Background work | Cron `*/15` and `*/5` |
| Custom hostnames | Cloudflare for SaaS |
| Auth | Better Auth on D1. Email and password. Google is optional. Password reset uses the Email Service binding `EMAIL`. |
| Sign-in mail from | `ChampBeam <no-reply@champbeam.com>` when `EMAIL` is bound |

The SPA and the API share an origin, so a production frontend build leaves `VITE_API_URL` unset and calls `/api/v1`. Static files under `/assets/*` skip the Worker. Every other path runs Worker code first (`run_worker_first` in `wrangler.jsonc`).

The FastAPI app in `backend/` is a legacy reference. See the README section "Legacy FastAPI backend". Clerk settings on the Worker are parsed and unused. Do not set `CLERK_*` secrets.

## 1. One-time setup

Needs a Cloudflare account that can attach D1, R2, cron triggers, and the Email Service binding, plus Node 22 and `npx wrangler login`.

```bash
cd worker
npm ci

# Only when creating a new database. Production's database_id is already in wrangler.jsonc.
npx wrangler d1 create champbeam
npx wrangler d1 migrations apply champbeam --remote

# Only when creating a new bucket. Production uses champbeam-files.
npx wrangler r2 bucket create champbeam-files
```

### Secrets and vars

The Worker throws at startup if `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, or `STORAGE_UPLOAD_SECRET` is missing.

```bash
npx wrangler secret put BETTER_AUTH_SECRET       # 32 or more random bytes
npx wrangler secret put STORAGE_UPLOAD_SECRET    # long random string
# Google sign-in. Both, or neither. Off when either is empty.
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
# Optional, same names as before:
npx wrangler secret put SERVICE_API_KEYS         # name:key,...
npx wrangler secret put CHAMPVAULT_API_KEY
npx wrangler secret put CLOUDFLARE_API_TOKEN     # custom hostnames and registrar
npx wrangler secret put MAXMIND_LICENSE_KEY      # only with the MaxMind web service
npx wrangler secret put IPINFO_API_TOKEN
npx wrangler secret put COMPANY_INTEL_API_KEY
npx wrangler secret put PROVISIONER_TOKEN
npx wrangler secret put ASSISTANT_OPENROUTER_API_KEY
npx wrangler secret put ASSISTANT_VERCEL_API_KEY
# Optional: browser uploads straight to R2 (no Worker body limit)
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
```

`BETTER_AUTH_URL` is a plain var, not a secret. Production is `https://champbeam.com`. The Google redirect URI is `<BETTER_AUTH_URL>/api/auth/callback/google`.

Other plain settings live under `vars` in `wrangler.jsonc` (`FRONTEND_URL`, `REDIRECT_BASE_URL`, `PLATFORM_REDIRECT_HOST`, `CORS_ALLOW_ORIGINS`, `CLOUDFLARE_ZONE_ID`, `CLOUDFLARE_CNAME_TARGET`, `R2_ACCOUNT_ID`, and the rest). Use placeholders in examples and chats. Never paste a live secret into a doc or a pull request.

### Large uploads

Without R2 API credentials, uploads stream through the Worker. The default cap is `WORKER_UPLOAD_MAX_BYTES` (100 MB). For bigger videos, create an R2 API token (Object Read and Write) and set `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY`. The browser then uploads straight to R2 with presigned URLs. Add a CORS rule on the bucket that allows `PUT` from the app origin.

### Password reset mail

`send_email` binding name `EMAIL` is declared on the production Worker and on the staging overlay. Overlays do not inherit it, so staging declares its own. With no binding, reset requests succeed and no mail is sent. Reset links use `BETTER_AUTH_URL`, so staging must stay on `staging.champbeam.com` (a `workers.dev` host in the link is a bad idea for mailbox filtering).

## 2. Build and deploy

```bash
cd worker
VITE_GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com npm run deploy
```

`npm run deploy` builds `frontend/`, then runs `wrangler deploy`. The Google value is the public client id. The sign-in page shows "Continue with Google" only when the frontend build contains it. Use a placeholder here. Do not copy a live id into this file.

Workers Builds: root directory `worker`, build command `npm run build:frontend`, deploy command `npx wrangler deploy`, and `VITE_GOOGLE_CLIENT_ID` as a build variable.

## 3. Domains and environments

- App: Workers, champbeam, Settings, Domains. Add `champbeam.com` and `www.champbeam.com`. The zone is on Cloudflare.
- Staging: wrangler environment `staging`, Worker name `champbeam-staging`, custom domain `staging.champbeam.com`. Its D1 database and R2 bucket are separate from production (`champbeam-staging`, `champbeam-files-staging`). See [docs/ENVIRONMENTS.md](docs/ENVIRONMENTS.md).
- `PLATFORM_REDIRECT_HOST` lists every host that has minted platform links, so those links keep resolving. Production's list is the `vars` block in `wrangler.jsonc`. Do not drop a host that still appears in links you need to serve.
- Customer hostnames use Cloudflare for SaaS (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ZONE_ID`, `CLOUDFLARE_CNAME_TARGET`). Pending hostnames are refreshed every 5 minutes. `POST /api/v1/domains/{id}/refresh` checks on demand.
- `deepify` in `wrangler.jsonc` is a local rehearsal overlay (pinned config, local D1 and R2). It is not a Cloudflare deployment and it must not share production's database or bucket. `node worker/scripts/check-env-overlays.mjs` enforces that split.

## 4. Moving data (already done for the cutover)

The 6 Nov 2026 cutover loaded Postgres into D1 and file bytes into R2. The scripts remain if you have to rehearse a fresh import into an empty database. Run them from a machine that has the backend's Python dependencies (`pip install -r requirements.txt`). Do not point them at the live production database unless you mean to replace it.

```bash
# Rows: Postgres -> D1. The export expects an empty D1 database.
python worker/scripts/export_postgres_to_d1.py "$DATABASE_URL" --out d1-export
for f in d1-export/*.sql; do npx wrangler d1 execute champbeam --remote --file "$f"; done

# File bytes -> R2. --source mongo | s3 | local
R2_ACCOUNT_ID=your-account-id R2_ACCESS_KEY_ID=your-access-key-id \
R2_SECRET_ACCESS_KEY=your-secret-access-key R2_BUCKET_NAME=champbeam-files \
python worker/scripts/copy_blobs_to_r2.py --database-url "$DATABASE_URL" --source s3
```

Replace every `your-*` value locally. Do not commit them. Reset a rehearsal database before a final import (`wrangler d1 delete`, then `create`, then `migrations apply`). The blob copy skips objects already in R2, so it is safe to re-run. Do a full rehearsal before any import you intend to keep.

## 5. Local development

```bash
cd worker
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npx wrangler dev --port 8799
```

For frontend hot reload, in another terminal:

```bash
cd frontend
cp .env.example .env.local    # VITE_API_URL=/api/v1
npm run dev                   # http://localhost:5173, proxies /api to port 8799
```

Set `BETTER_AUTH_URL` in `.dev.vars` to the origin you open (`http://localhost:5173` for Vite, or `http://127.0.0.1:8799` if you open wrangler directly). The session cookie stays on that origin.

`PLATFORM_REDIRECT_HOST` in local dev must list `127.0.0.1` and `localhost` (the example file does). Any other host is treated as a customer domain and refused unless it is registered and active.

## 6. Verifying

- Unit and route tests: `cd worker && npm test`. Vitest runs in workerd against an in-memory D1 and R2.
- End to end, locally: `cd worker && bash scripts/e2e-local.sh`. Fresh local D1, built SPA, `wrangler dev` on port 8799, then link generate, `/r` redirect, file upload to R2, `/f` serve (including Range), Beam Page publish, `/p` serve, and projects.
- Against a deployment: `node worker/scripts/e2e-smoke.mjs https://<host> cb_live_<key>`. It creates and then deletes its own link, file, page, and project.

## 7. Differences from the FastAPI app

Paths, status codes, and response shapes were ported to match. Deliberate differences:

- Geo comes from Cloudflare (`request.cf`) instead of MaxMind `.mmdb` files. The MaxMind web service and IPinfo still apply when configured. ip-api.com is not called. User-agent parsing uses `ua-parser-js`.
- Range requests on `/f` return 206. A seek after byte 0 does not count as a new view. HEAD is answered on `/f` and `/p`.
- D1 has no interactive transactions. Multi-row writes use batches. Click and view counters use atomic SQL increments.
- Background loops are cron jobs: domain status every 5 minutes, expired-upload sweep every 15 minutes.
- Uploads through the Worker are capped at 100 MB unless R2 presigned uploads are configured (section 1).
- Some malformed ids that used to return 500 now return 400, 404, or 422.
- Timestamps are stored with millisecond precision.
- Sign-in is Better Auth (cookie session), not Clerk bearer tokens. The `/api/v1/webhooks/clerk` route remains and returns 503 unless `CLERK_WEBHOOK_SECRET` is set. Production does not use it.
