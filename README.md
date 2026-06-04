# ChampUTM - Smart UTM Link Generator

**ChampUTM** is a powerful, user-friendly UTM tracking and analytics platform that helps marketers create, manage, and analyze campaign links with ease.

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

### 🔐 Account Security
- Email + password authentication with JWT
- "Forgot password?" 2-step reset flow with Resend
- Authenticated "Change password" with old-session invalidation
- Tokens stored bcrypt-hashed; reset links single-use and time-limited

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
champutm/
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
POSTGRES_USER=champutm
POSTGRES_PASSWORD=champutm_dev
POSTGRES_DB=champutm
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

Leave `REDIRECT_BASE_URL` and the `CLOUDFLARE_*` vars unset for local
dev, `/r/{code}` will use whatever Host the client called and BYOD
domains land in `active` status without a real cert. File hosting works
out of the box: `STORAGE_BACKEND` defaults to `local`, writing uploads
under `STORAGE_LOCAL_PATH` (`./data/files`).

### Production, Railway (backend)

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

# Custom Domains (BYOD), see the Custom Domains section below.
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
VITE_API_URL=https://<your-app>.up.railway.app
```

Short links, `https://<railway-host>/r/{short_code}`, resolve directly
against the backend. `frontend/vercel.json` rewrites every path to
`index.html` (the SPA fallback), so `/r/*` on the Vercel hostname just
renders the SPA, not a redirect. To put short links on a branded URL,
use Custom Domains below.

### Custom Domains (Bring-Your-Own-Domain)

Each user can attach their own hostname (e.g. `track.acme.com`) for
branded short links and file URLs. The backend routes incoming
requests by `Host` header into the right per-account namespace.
`LinkClick.short_code` and `FileAsset.short_code` are unique per
domain (partial indexes from migrations 008 + 009), so two accounts
can safely reuse the same short code on their own domains.

**One-time platform setup (Cloudflare for SaaS):**

1. Add the zone you'll use as the CNAME target (e.g. `champutm.com`)
   to Cloudflare and enable **Cloudflare for SaaS**.
2. Set the **Fallback Origin** to the Railway backend hostname (the
   `*.up.railway.app` host or your Railway custom domain).
3. Create a public DNS record: `cname.champutm.com CNAME <railway-host>`.
4. Mint an API token scoped to that zone with
   `Zone.SSL and Certificates:Edit` + `Zone.Zone Settings:Edit`.
5. Set `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ZONE_ID`, and
   `CLOUDFLARE_CNAME_TARGET=cname.champutm.com` on Railway.

**Per-customer flow:** the customer adds
`track.acme.com CNAME cname.champutm.com` in their DNS, then `POST
/api/v1/domains` provisions a Custom Hostname via the CF API. Status
flips `pending_cname` → `pending_ssl` → `active` as DNS resolves and
the cert issues; `/api/v1/domains/health` returns a diagnostic
snapshot for any stuck domain.

**Local development:** leave the `CLOUDFLARE_*` vars empty. New
domains are created in `active` status without a real cert so the
full happy path is testable via curl with a spoofed Host header:

```bash
curl -i -H "Host: track.example.com" http://localhost:8000/r/<short_code>
```

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
| Backend  | Railway | `nixpacks` build per `railway.toml`. Postgres + Redis plugins. |
| Custom-hostname certs | Cloudflare for SaaS | One zone hosts the per-tenant CNAME target. |
| File storage | Local disk / MongoDB GridFS / S3-compatible | `STORAGE_BACKEND` selects: `local` needs a Railway Volume, `mongo` the Mongo plugin, `s3` any bucket (Supabase / Cloudflare R2). |

On every Railway deploy the boot sequence is:

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
