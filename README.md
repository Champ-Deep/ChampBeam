# ChampBeam

ChampBeam is smart links, QR codes, and file tracking, served at [https://champbeam.com](https://champbeam.com). ChampUTM, the UTM link builder, lives in the same app: tagged URLs, presets, bulk CSV, and campaign analytics.

Since the 6 Nov 2026 cutover (PR #58), production is one Cloudflare Worker in `worker/`. That Worker serves the React SPA, the API, short links, files, and pages. Sessions and rows are in D1 (Drizzle). File bytes are in R2. Sign-in is Better Auth. Cron triggers run the background jobs.

The Python app in `backend/` is a legacy reference implementation. It is not what https://champbeam.com runs. See [Legacy FastAPI backend](#legacy-fastapi-backend).

## What you can do

### Smart links

A signed-in user gets a short link on `/s/{code}` and `/r/{code}`. A visit records geo, device, and referrer, then redirects. An optional alias makes the path readable (`/s/your-name`). Anyone can build a UTM-tagged URL without an account. The short link and its click history require a sign-in.

### QR codes

`GET /api/v1/qr.svg?data=<url>` returns an SVG of that URL. No auth. The app shows the same code on links and files. A scan opens the short link or file URL, so it is tracked as a click or open. There is no separate QR store.

### File tracking

`POST /api/v1/files` starts an upload with or without an account. The file is served at `/f/{code}`, and each open is recorded (including a read receipt). Guest uploads expire (default 24 hours, `ANON_FILE_TTL_SECONDS`) and use a tighter size cap. Signed-in uploads count against `MAX_BYTES_PER_USER` (default 5 GiB) and do not use that expiry. Bytes live in the R2 binding `FILES`.

### Pages

Hosted HTML is published at `/p/{slug}` (Beam Pages): a stable URL, versions, and the same open tracking. The SPA lists them under Pages. Publishing requires a sign-in. Reading a published page does not.

### ChampUTM

The Links area is ChampUTM: `utm_source`, `utm_medium`, `utm_campaign`, and the other UTM fields, saved presets, a CSV bulk generator, projects, and campaign analytics. Presets, bulk generation, and saved links require an account.

### Teams

Organizations are Better Auth orgs stored in D1. Users cannot create organizations in the app. When the default organization exists, a new account joins it as a member. An admin keeps a shared content library. A member shares an item and gets their own tracked link or file. Team analytics roll opens up by content item and by member. Permissions come from the server (`worker/src/auth/permissions.ts`).

### Custom domains

Cloudflare for SaaS can serve the same short links and files on a hostname you attach. In-app search and registration use the Cloudflare Registrar API when `CLOUDFLARE_ACCOUNT_ID` and a registrar-scoped token are set. Leave those unset and the buy flow stays off. `PLATFORM_SUBDOMAIN_BASE` is a separate, optional platform-subdomain model.

## Stack

| Piece | Production |
|---|---|
| SPA | React 18, TypeScript, Vite, Tailwind CSS. Built to `frontend/dist` and served as Worker static assets. |
| API and public routes | Hono (`worker/src`) |
| Auth | Better Auth. Sessions in D1. Cookie `champbeam.session_token`. Email and password. Google when both client id and secret are set. Password reset uses the Email Service binding `EMAIL`. |
| Database | Cloudflare D1, Drizzle (`worker/src/db`, `worker/migrations`) |
| Files | R2 binding `FILES` |
| Rate limits | D1 table `rate_counters` |
| Geo | `request.cf` on each request. The MaxMind web service and IPinfo are optional enrichers. |
| Jobs | Cron `*/15` (expired uploads and rate-counter cleanup) and `*/5` (custom-domain status) |
| Legacy reference | FastAPI, Postgres, Redis, Clerk, in `backend/` |

## Layout

```
worker/      production Worker (Hono, Drizzle, Better Auth)
frontend/    React SPA, built into the Worker
backend/     legacy FastAPI reference (not production)
deploy/      legacy VPS Compose stack for that FastAPI app
docs/        API notes, environments, tests
```

Routes the Worker actually serves (`worker/src/app.ts`, `worker/wrangler.jsonc`):

- SPA routes, including `/`, `/links`, `/files`, `/pages`, `/library`, `/team`, `/settings`, `/sign-in`, `/sign-up`, `/forgot-password`, `/reset-password`
- `/api/auth/*`: Better Auth (sign-in, sessions, Google callback, password reset)
- `/api/v1/*`: the API
- `/r/{code}` and `/s/{code}`: tracked redirects
- `/f/{code}`: files
- `/p/{slug}`: pages
- `/health`: D1 check. A healthy database returns `{"status":"healthy","database":"connected"}`

Hashed files under `/assets/*` are served as static assets. Every other path runs the Worker first (`run_worker_first`).

## Local development

CI uses Node 22 for the Worker and Node 20 for the frontend. Two processes:

```bash
cd worker
npm ci
cp .dev.vars.example .dev.vars   # then set the three required values below
npm run db:migrate:local
npx wrangler dev --port 8799
```

```bash
cd frontend
npm ci
cp .env.example .env.local
npm run dev
```

Open http://localhost:5173. Vite proxies `/api` to http://127.0.0.1:8799 (`frontend/vite.config.ts`). `VITE_API_URL=/api/v1` keeps those calls on the Vite origin. In `worker/.dev.vars`, set `BETTER_AUTH_URL=http://localhost:5173` so it matches the origin you open. If you instead build the SPA and open wrangler itself, point `BETTER_AUTH_URL` at that origin (the example file uses `http://127.0.0.1:8799`). A mismatch fails the CSRF origin check.

The Worker refuses to start until these three are set. Placeholders are fine locally. Do not commit `.dev.vars`.

```env
BETTER_AUTH_SECRET=replace-with-32-plus-random-bytes
BETTER_AUTH_URL=http://localhost:5173
STORAGE_UPLOAD_SECRET=replace-with-a-long-random-string
```

One process, built SPA plus API:

```bash
cd worker
npm --prefix ../frontend run build
npx wrangler dev
```

Wrangler defaults to http://localhost:8787. Set `BETTER_AUTH_URL` to that origin before you rely on sign-in.

## Configuration

Non-secret production settings live under `vars` in `worker/wrangler.jsonc`: `ENVIRONMENT`, `FRONTEND_URL`, `BETTER_AUTH_URL`, `REDIRECT_BASE_URL`, `PLATFORM_REDIRECT_HOST`, `CORS_ALLOW_ORIGINS`, `STORAGE_PUBLIC_BUCKET_NAME`. They point at https://champbeam.com.

Secrets go in `npx wrangler secret put`, or in `.dev.vars` locally. Never commit them.

Required:

- `BETTER_AUTH_SECRET` (32 or more random bytes)
- `STORAGE_UPLOAD_SECRET`

`BETTER_AUTH_URL` is a var, not a secret. Production is `https://champbeam.com`.

Optional. The feature stays off when the value is empty:

- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Redirect URI: `<BETTER_AUTH_URL>/api/auth/callback/google`.
- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` so the browser uploads straight to R2. Without them, uploads stream through the Worker, which caps a request body (default `WORKER_UPLOAD_MAX_BYTES`, 100 MB).
- `CLOUDFLARE_API_TOKEN`, plus vars `CLOUDFLARE_ZONE_ID` and `CLOUDFLARE_CNAME_TARGET`, for custom hostnames.
- `CLOUDFLARE_ACCOUNT_ID` for in-app domain registration. Optional `CLOUDFLARE_REGISTRANT_EMAIL`.
- `MAXMIND_ACCOUNT_ID` and `MAXMIND_LICENSE_KEY`, and `IPINFO_API_TOKEN`, for extra geo.
- `SERVICE_API_KEYS`, `CHAMPVAULT_URL`, `CHAMPVAULT_API_KEY`.
- `ASSISTANT_OPENROUTER_API_KEY`, `ASSISTANT_VERCEL_API_KEY`.
- `PROVISIONER_TOKEN`, `COMPANY_INTEL_API_KEY`.
- `SYSTEM_ADMIN_CLERK_IDS`: comma-separated ids allowed to call `/api/v1/system`. The name is historical. Empty means nobody. An organization admin role does not grant this.

`CLERK_*` is still parsed and does nothing for sign-in. Do not put Clerk keys on the Worker.

Frontend build-time variables are in `frontend/.env.example`:

- `VITE_API_URL`: leave unset on a production build. The client then uses `/api/v1` on the same origin. Vite dev needs `/api/v1` so the proxy is used. An unset dev build calls `http://localhost:8000/api/v1`, which is the legacy API port.
- `VITE_GOOGLE_CLIENT_ID`: the public Google client id, the same value as `GOOGLE_CLIENT_ID`. The Google button is hidden when this is empty. Set it as a Workers Builds variable. It is not a secret. The example file uses a placeholder, not a real id.
- `VITE_ANNOUNCEMENT`: optional banner text. Unset means no banner.

Password reset mail needs the `send_email` binding named `EMAIL` (declared on the production Worker and on the staging overlay). The from address is `ChampBeam <no-reply@champbeam.com>`. With no binding, no mail is sent.

`PLATFORM_REDIRECT_HOST` must list every host that should resolve platform short links. A host that is not listed is treated as a customer domain and is refused unless that domain row is active. Production's list is in `wrangler.jsonc`.

## Deploy

From `worker/`:

```bash
VITE_GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com npm run deploy
```

That installs and builds `frontend/`, then runs `wrangler deploy`. Workers Builds should use root directory `worker`, build command `npm run build:frontend`, deploy command `npx wrangler deploy`, and `VITE_GOOGLE_CLIENT_ID` as a build variable.

Attach `champbeam.com` and `www.champbeam.com` as custom domains on the Worker. Staging is the wrangler environment `staging` at https://staging.champbeam.com, with its own D1 database and R2 bucket. The `deepify` overlay is a local rehearsal. It is not the Cloudflare control plane. Details: [CLOUDFLARE_DEPLOY.md](CLOUDFLARE_DEPLOY.md) and [docs/ENVIRONMENTS.md](docs/ENVIRONMENTS.md).

Production D1 migrations:

```bash
cd worker && npm run db:migrate:remote
```

Staging is a different database (`champbeam-staging`). Apply migrations there with wrangler `--env staging`. Do not point that command at the production database.

## Tests

CI (`.github/workflows/ci.yml`) runs on pull requests and on pushes to `main` and `staging`. It does not deploy. The `gate` job is the combined check.

```bash
cd worker && npm test && npx tsc --noEmit
cd frontend && npm test && npm run lint
cd backend && python -m pytest -q
```

`npm test` in `worker/` runs Vitest inside workerd against an in-memory D1 and R2. Local smoke of a real `wrangler dev`: `cd worker && bash scripts/e2e-local.sh`. Against a deployed host: `node worker/scripts/e2e-smoke.mjs https://<host> cb_live_<key>`. That script creates and then deletes its own link, file, page, and project.

## Legacy FastAPI backend

`backend/` is the previous application: FastAPI, SQLAlchemy, Alembic, Postgres, Redis, and Clerk session tokens. File bytes could sit on local disk, in MongoDB GridFS, or in any S3-compatible store (including R2) via `STORAGE_BACKEND`. The Compose stack in `deploy/` (app, Postgres, Redis, Caddy) and the Railway files (`railway.toml`, `backend/railway.toml`, `Procfile`) belong to that app.

It stays in the tree so behaviour can be compared and so its tests still run. New production work belongs in `worker/` and `frontend/`.

A Railway process can still catch an old hostname. Set `CF_REDIRECT_BASE` (for example `https://champbeam.com`) and every request except `/health` redirects to the Worker. Unset the variable and the process serves FastAPI again. That redirect is a wind-down, not the product.

Run the legacy API only when you need the reference stack:

```bash
cd backend
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
# copy backend/.env.example to backend/.env and fill the placeholders
alembic upgrade head
uvicorn app.main:app --reload
```

`backend/.env.example` and `deploy/.env.example` document that stack, including Clerk. They are not the production Worker config.

The pre-cutover go-live checklist (Vercel for the UI, a VPS for the API, Clerk for auth) is archived in [PRODUCTION_CUTOVER.md](PRODUCTION_CUTOVER.md). Do not follow it for champbeam.com.

## More docs

- [CLOUDFLARE_DEPLOY.md](CLOUDFLARE_DEPLOY.md): Worker setup, secrets, domains, and the one-time data move
- [docs/ENVIRONMENTS.md](docs/ENVIRONMENTS.md): production, staging, the deepify overlay, and the legacy app
- [docs/API.md](docs/API.md): integration quickstart
- [docs/DEPLOY-TROUBLESHOOTING.md](docs/DEPLOY-TROUBLESHOOTING.md): legacy FastAPI boot failures
- [worker/PORTING.md](worker/PORTING.md): how the Python handlers map onto the Worker

## License

MIT. See [LICENSE](LICENSE).
