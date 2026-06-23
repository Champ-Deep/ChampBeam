# Champbeam - Smart UTM Link Generator

**Champbeam** is a powerful, user-friendly UTM tracking and analytics platform that helps marketers create, manage, and analyze campaign links with ease.

## Features

### 🔗 Public Link Generator
- Generate UTM-tagged links instantly without signing up
- Clean, intuitive interface
- Recent links saved locally

### 📤 File Sharing with Read Receipts
- Share PDFs, video, images, and HTML as one trackable link, no signup needed
- Real-time "Seen ✓ / Not opened yet" read receipts on every file
- Geo + device analytics on each open; guest links auto-expire

### 📋 Presets (Account Required)
- Save reusable UTM templates
- Quick-apply presets to any URL
- Team-wide preset sharing (coming soon)

### 📊 Analytics Dashboard (Account Required)
- Track click performance across all your links
- Breakdown by source, medium, campaign
- Visual charts and insights

### 📦 Bulk Generator (Account Required)
- Upload CSV with multiple URLs
- Apply presets or custom UTM parameters
- Download tracked URLs instantly

### 👥 Teams & Shared Content Library (Organizations)
- Built on Clerk Organizations: an **admin** (e.g. the marketing team) and
  **members** (e.g. sales reps), with role-based access enforced on the backend
- The admin curates a **content library** (links or files); each member shares an
  item to mint their *own* tracked link/file — on their own domain if they have one
- The admin's **Team Analytics** consolidates engagement by content item, so the
  same content shared by different members via different links is recognized as
  one piece and its stats are rolled up, with a per-member breakdown of who drove
  the opens. See the "Teams / Organizations" section below.

### 🌐 Custom Domains + In-App Domain Procurement
- Bring your own domain (`track.acme.com`) via Cloudflare for SaaS, or claim an
  instant platform subdomain
- **Buy a domain in-app** (Cloudflare Registrar): search names, see live pricing,
  one-click register, and we auto-wire it to serve links. See "Custom Domains".

### 🔐 Account Security
- Authentication, sessions, and password reset are managed by Clerk
- The backend verifies Clerk session tokens (JWKS, RS256) on every protected
  endpoint, and in production also enforces the issuer (`iss`) and authorized
  party (`azp`) and keeps a local user/org mirror in sync via a signed webhook

## Tech Stack

**Frontend:**
- React 18 with TypeScript
- Vite for fast development
- TailwindCSS for styling
- React Query for data fetching
- Recharts for analytics visualizations

**Backend:**
- FastAPI (Python 3.11+)
- PostgreSQL for data storage
- Redis for caching
- SQLAlchemy ORM
- Alembic for migrations
- Object storage for files: local disk, MongoDB GridFS, or S3-compatible (Supabase / Cloudflare R2)

## Quick Start

### Prerequisites
- Node.js 18+
- Python 3.11+
- PostgreSQL 14+
- Redis 7+

### Frontend Development
```bash
cd frontend
npm install
npm run dev
```

### Backend Development
```bash
cd backend
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate
pip install -r requirements.txt
alembic upgrade head
uvicorn app.main:app --reload
```

## Project Structure

```
champbeam/
├── frontend/          # React application
│   ├── src/
│   │   ├── api/       # API client functions
│   │   ├── components/# Reusable UI components
│   │   ├── pages/     # Page components
│   │   └── hooks/     # Custom React hooks
│   └── package.json
│
├── backend/           # FastAPI application
│   ├── app/
│   │   ├── api/       # API endpoints
│   │   ├── models/    # Database models
│   │   ├── services/  # Business logic
│   │   └── core/      # Config and security
│   └── requirements.txt
│
└── README.md
```

## Environment Variables

Configuration lives in `backend/app/core/config.py` (pydantic-settings).
Anything unset there falls back to a sensible local-dev value. Local
overrides go in `backend/.env`; production overrides are set on the
deployment platform.

### Local development

Backend (`backend/.env`, copy from `backend/.env.example`):

```env
# Postgres + Redis run on localhost by default. Leave DATABASE_URL unset
# and the backend assembles a URL from POSTGRES_* below; set DATABASE_URL
# only if you need to point at a non-local Postgres.
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_USER=champbeam
POSTGRES_PASSWORD=champbeam_dev
POSTGRES_DB=champbeam
REDIS_URL=redis://localhost:6379/0

# Clerk session-token verification (mint a key in your Clerk dashboard).
CLERK_SECRET_KEY=sk_test_...

# Frontend origin used for CORS; must match the Vite dev server.
FRONTEND_URL=http://localhost:5173
```

Frontend (`frontend/.env`):

```env
VITE_API_URL=http://localhost:8000
```

Leave `REDIRECT_BASE_URL`, `PLATFORM_SUBDOMAIN_BASE`, and the
`CLOUDFLARE_*` vars unset for local dev, `/r/{code}` will use whatever
Host the client called, and you can spoof a custom Host header to test
routing (see the Custom Domains section). File hosting works out of the
box: `STORAGE_BACKEND` defaults to `local`, writing uploads under
`STORAGE_LOCAL_PATH` (`./data/files`).

### Production, VPS (Docker Compose, recommended)

The backend ships with a single-droplet Docker Compose stack in `deploy/`
that runs the app, Postgres, Redis, and Caddy (automatic HTTPS). It serves
the API, the short links (`/r/...`), and files (`/f/...`) on the
`champbeam.com` root. The app UI stays on Vercel.

1. **Provision a droplet** (DigitalOcean or any VPS) with Docker + the
   Compose plugin installed, and open ports 80 and 443.
2. **Point DNS:** create an `A` record `champbeam.com -> <droplet IP>`.
   Put the app UI on its own host (e.g. `app.champbeam.com` as a CNAME to
   Vercel).
3. **Configure + launch:**
   ```bash
   git clone <this repo> && cd <repo>/deploy
   cp .env.example .env          # then fill it in: Clerk, R2, a strong DB password
   docker compose up -d --build
   ```
   On first boot the app container runs `bootstrap_db.py` + `alembic
   upgrade head`, then serves on :8000 behind Caddy, which fetches the
   Let's Encrypt certificate for `champbeam.com` automatically once DNS
   resolves.
4. **Point the frontend at it:** set `VITE_API_URL=https://champbeam.com`
   in Vercel, and `FRONTEND_URL=https://app.champbeam.com` in `deploy/.env`
   so CORS admits the UI origin.
5. **Storage:** the template defaults to Cloudflare R2
   (`STORAGE_BACKEND=s3`), which keeps file bytes off the droplet. Fill in
   the `SUPABASE_STORAGE_*` (R2) values, or switch to `local`/`mongo`.

**Migrating data off Railway** (one time, only if you have existing data):
```bash
# with both Postgres connection strings handy:
pg_dump "<railway DATABASE_URL>" --no-owner --no-privileges -Fc -f champbeam.dump
# copy the dump to the droplet, then restore into the compose Postgres:
docker compose cp champbeam.dump postgres:/tmp/champbeam.dump
docker compose exec postgres pg_restore -U champbeam -d champbeam --no-owner /tmp/champbeam.dump
```
Files in R2 are untouched by the move; only the Postgres data comes across.

#### Error monitoring (Sentry)

The droplet already runs a self-hosted Sentry. Wiring the backend to it is
a small, separate task:

1. Add `sentry-sdk[fastapi]` to `backend/requirements.txt`.
2. Initialize it once, as early as possible in `backend/app/main.py`,
   guarded by the env var so it stays off until a DSN is set:
   ```python
   import os, sentry_sdk
   if os.getenv("SENTRY_DSN"):
       sentry_sdk.init(
           dsn=os.environ["SENTRY_DSN"],
           traces_sample_rate=0.1,
           environment=os.getenv("ENVIRONMENT", "production"),
       )
   ```
3. Set `SENTRY_DSN=<your self-hosted project DSN>` in `deploy/.env` and
   redeploy (`docker compose up -d --build`). An empty `SENTRY_DSN` keeps
   Sentry disabled.

### Production, Railway (backend, alternative)

Add the **Postgres** and **Redis** plugins to your Railway project.
Both auto-inject env vars the backend already knows how to consume:

| Variable | Source | Used for |
|---|---|---|
| `DATABASE_URL` | Postgres plugin (auto) | Async SQLAlchemy connection |
| `REDIS_URL`    | Redis plugin (auto)    | Cache + rate limiting |
| `PORT`         | Railway runtime (auto) | Bound by the `railway.toml` start command |

You must set these yourself in the Railway service variables:

```env
CLERK_SECRET_KEY=sk_live_...
FRONTEND_URL=https://<your-vercel-host>     # exact origin for CORS
ENVIRONMENT=production
DEBUG=false

# Custom Domains, see the Custom Domains section below.
# Platform subdomains (default model): the base zone you own a wildcard for.
# Set this only after *.<base> DNS + cert are live (see the section below).
PLATFORM_SUBDOMAIN_BASE=share.lakeb2b.com
# Bring-Your-Own-Domain (upgrade): all three turn the BYOD path on. Optional.
CLOUDFLARE_API_TOKEN=...
CLOUDFLARE_ZONE_ID=...
CLOUDFLARE_CNAME_TARGET=cname.yourdomain.com

# File hosting, pick a storage backend (see the File hosting section).
#   local (default): mount a Railway VOLUME at STORAGE_LOCAL_PATH or uploads reset on redeploy
#   mongo: add the Railway Mongo plugin, then set STORAGE_BACKEND=mongo + MONGO_URL
#   s3:    any S3-compatible bucket (Supabase Storage, Cloudflare R2, ...)
STORAGE_BACKEND=local
STORAGE_LOCAL_PATH=/data/files            # mount a Railway Volume here
STORAGE_UPLOAD_SECRET=<long-random-string>
```

`railway.toml` already runs `bootstrap_db.py` + `alembic upgrade head`
before booting uvicorn, so schema migrations apply automatically on
every deploy.

### Production, Vercel (frontend)

In **Project Settings → Environment Variables**:

```env
VITE_API_URL=https://champbeam.com
```

Short links, `https://champbeam.com/r/{short_code}`, resolve directly
against the backend. `frontend/vercel.json` rewrites every path to
`index.html` (the SPA fallback), so `/r/*` on the Vercel hostname just
renders the SPA, not a redirect. To put short links on a branded URL,
use Custom Domains below.

### Custom Domains

Each user can serve branded short links and file URLs on their own
hostname. The backend routes incoming requests by `Host` header into
the right per-account namespace. `LinkClick.short_code` and
`FileAsset.short_code` are unique per domain (partial indexes from
migrations 008 + 009), so two accounts can safely reuse the same short
code on their own domains. There are two models, and they share all of
this routing code:

#### Model 1, platform subdomain (default, no Cloudflare for SaaS needed)

A tenant claims a single-label subdomain of a base you own, e.g.
`acme.share.lakeb2b.com`, and it goes live instantly. This rides the
platform wildcard, so there is no per-host cert to wait on.

One-time platform setup:

1. **DNS:** create a wildcard CNAME `*.share.lakeb2b.com` →
   `<railway-host>.up.railway.app`. If you proxy it through Cloudflare
   (orange cloud), Cloudflare also issues the wildcard cert for free.
2. **TLS:** confirm a wildcard cert for `*.share.lakeb2b.com` is
   serving (Cloudflare Universal SSL covers one level out of the box;
   on Railway, add the wildcard as a custom domain).
3. **Then** set `PLATFORM_SUBDOMAIN_BASE=share.lakeb2b.com` on the
   backend and redeploy. Claimed subdomains are marked active
   immediately, so set this only after steps 1 and 2 actually resolve,
   or a domain will show "Live" without connecting.

The "Claim a subdomain" card in **Settings → Domains** appears only
when `PLATFORM_SUBDOMAIN_BASE` is set.

#### Model 2, bring-your-own-domain (upgrade, Cloudflare for SaaS)

A customer points their own hostname (`track.acme.com`) at us and we
issue/serve the cert for it. One-time platform setup:

1. Add the zone you'll use as the CNAME target (e.g. `champbeam.com`)
   to Cloudflare and enable **Cloudflare for SaaS**.
2. Set the **Fallback Origin** to the Railway backend hostname (the
   `*.up.railway.app` host or your Railway custom domain).
3. Create a public DNS record: `cname.champbeam.com CNAME <railway-host>`.
4. Mint an API token scoped to that zone with
   `Zone.SSL and Certificates:Edit` + `Zone.Zone Settings:Edit`.
5. Set `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ZONE_ID`, and
   `CLOUDFLARE_CNAME_TARGET=cname.champbeam.com` on Railway. **No backend
   code changes are needed, just these three vars + a redeploy.**

Per-customer flow: the customer adds `track.acme.com CNAME
cname.champbeam.com` in their DNS, then `POST /api/v1/domains`
provisions a Custom Hostname via the CF API. Status flips
`pending_cname` → `pending_ssl` → `active` as DNS resolves and the cert
issues; `/api/v1/domains/health` returns a diagnostic snapshot for any
stuck domain.

#### Model 3, in-app domain procurement (Cloudflare Registrar, beta)

Let a user **buy** a domain without leaving the app. One-time setup:

1. Have the registering token carry **Registrar write** scope (the
   `CLOUDFLARE_API_TOKEN` above can be reused if scoped accordingly).
2. Set `CLOUDFLARE_ACCOUNT_ID` (and optionally
   `CLOUDFLARE_REGISTRANT_EMAIL` as the default registrant contact). Make
   sure the account has a default payment profile and registrant contact.

Then **Settings → Domains** shows a "Get a new domain" card backed by:

- `GET /api/v1/domains/search?q=` — name suggestions
- `POST /api/v1/domains/check` — live availability + price for exact names
- `POST /api/v1/domains/purchase` — register, then best-effort wire the link
  hostname (a Custom Hostname cert when Cloudflare-for-SaaS is on, plus a CNAME
  on the freshly created zone). Each wiring step degrades to a pending status
  with instructions rather than failing the purchase.

The Registrar API is in **beta**, supports a subset of TLDs, and registrations
are billed immediately and are non-refundable — keep `CLOUDFLARE_ACCOUNT_ID`
unset to hide the feature until you're ready.

#### Local development

Leave `PLATFORM_SUBDOMAIN_BASE` and the `CLOUDFLARE_*` vars empty. An
external domain you add stays `pending_cname` (it is never shown as
Live until it actually routes here), but you can still exercise the
full host-based routing path by spoofing the `Host` header against a
domain row you mark active directly:

```bash
curl -i -H "Host: track.example.com" http://localhost:8000/r/<short_code>
```

### Teams / Organizations

The team edition is built on **Clerk Organizations** — enable Organizations in
the Clerk Dashboard and the app reads `org_id` + role (`admin` / `member`) from
the session token. The premier use case: the **marketing team is the admin** and
**sales reps are members** who use the org as a shared repository of pitches and
video content to send to clients.

- **Shared content library** (`/library`): an admin adds canonical content —
  a destination link or an uploaded file. Members browse it and click **Share**
  to mint their *own* tracked link/file (their own short code, optionally on
  their own custom domain). No file re-upload: file shares reuse the master
  bytes under a fresh short code.
- **Consolidated analytics** (`/team`, admin only): the same content shared by
  different members via different links is recognized as **one content item**
  (every share carries the canonical `content_id`). The admin sees per-content
  totals, the best performers, and a **per-member breakdown** of who drove the
  opens — so marketing knows which pitches land and who's using them.

How it maps to the data model:

```
Content(id) ──< ContentShare(member, link/file) >── ClickEvent rows
                 (one per member share)              (opens/views)
```

Backend authorization is enforced by `require_org_member` / `require_org_admin`
(the frontend `OrgRoute` guards only mirror it). The local
`organizations` / `organization_memberships` mirror is kept current by the Clerk
webhook (`/api/v1/webhooks/clerk`, `CLERK_WEBHOOK_SECRET`) and, as a backstop,
lazily from the session token on each authenticated request. See
`PRODUCTION_CUTOVER.md` section **D2** for the dashboard + webhook setup.

### File hosting

Anyone can share a file at `POST /api/v1/files`, **no account
required**. The file gets a `/f/{short_code}` URL that serves the bytes
and records a tracked view per request, so the sender gets **read
receipts** ("Seen ✓ / Not opened yet") via
`GET /api/v1/files/{id}/status`. Signed-out (guest) uploads get tighter
size caps, a 24-hour auto-expiry (`ANON_FILE_TTL_SECONDS`), and an
`owner_token` to poll status; a background sweeper reclaims expired
blobs. Authenticated uploads never expire, count against a per-user
quota (`MAX_BYTES_PER_USER`, 5 GiB), and inherit BYOD routing -
uploading against a custom Domain lands the URL on that hostname.

**Storage backends** are swappable via `STORAGE_BACKEND`
(`app/services/storage.py`):

| Backend | `STORAGE_BACKEND` | Stores bytes in | Best for |
|---|---|---|---|
| Local disk (default) | `local` | `STORAGE_LOCAL_PATH` (mount a Railway **Volume**) | Quick start, self-contained |
| MongoDB GridFS | `mongo` | GridFS (`MONGO_URL`) | Railway testing, one-click plugin, no volume, survives redeploys |
| S3-compatible | `s3` | Supabase Storage / Cloudflare R2 / S3 / MinIO | Production scale |

`local` and `mongo` route uploads through a token-gated
`PUT /api/v1/files/{id}/blob` and stream serves back through the API;
`s3` uses presigned PUT/GET so bytes never transit the API. Switching
backends is an env-var change only, no code changes.

**Cloudflare R2 (S3-compatible), to scale up:** create a bucket and an
R2 API token (S3 credentials) in the Cloudflare dashboard, then set:

```env
STORAGE_BACKEND=s3
SUPABASE_STORAGE_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
SUPABASE_STORAGE_REGION=auto
SUPABASE_STORAGE_ACCESS_KEY_ID=<R2 access key id>
SUPABASE_STORAGE_SECRET_ACCESS_KEY=<R2 secret access key>
SUPABASE_STORAGE_BUCKET=<your bucket>
```

(The `SUPABASE_STORAGE_*` names are historical, they carry any
S3-compatible endpoint, R2 included.)

## Deployment

| Layer | Platform | Notes |
|---|---|---|
| Frontend | Vercel | SPA via `frontend/vercel.json`. Build `npm run build`, output `dist/`. |
| Backend  | DigitalOcean VPS (Docker Compose) | `deploy/` stack: app + Postgres + Redis + Caddy (auto-TLS). Railway also supported via `railway.toml`. |
| Custom-hostname certs | Cloudflare for SaaS | One zone hosts the per-tenant CNAME target. |
| File storage | Local disk / MongoDB GridFS / S3-compatible | `STORAGE_BACKEND` selects: `local` needs a Railway Volume, `mongo` the Mongo plugin, `s3` any bucket (Supabase / Cloudflare R2). |

On every deploy (VPS container start, or Railway) the boot sequence is:

1. `bootstrap_db.py`, stamps `alembic_version` if the DB was originally
   created via `Base.metadata.create_all()`, and idempotently backfills
   any missing columns. Safe to re-run.
2. `alembic upgrade head`, applies any new migrations.
3. `uvicorn` binds `$PORT` and serves the API.

Healthcheck path: `/health`. Railway rolls the deploy back if that
doesn't respond within 30 seconds.

## License

MIT License - see LICENSE file for details

## Contributing

Contributions welcome! Please open an issue or PR.

---

Built with ❤️ by the Champ team
