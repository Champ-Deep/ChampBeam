# Environments: how a change gets from a laptop to prod

> **Status 2026-10-17: the Coolify cutover is on hold.** Prod is the Railway
> project `ChampBeam`, environment `production`, auto-deploying `main`; the
> Railway `Testing` environment is the test stack. The `deploy-prod` CI job was
> removed. The Coolify sections below describe the parked target, not the live one.

Two backends, one image. Railway is the test stack, Deepify (Coolify on the VPS)
is prod, Vercel serves the UI for both. Everything that differs between the two
is an environment variable; nothing that differs is in code.

| | Test | Prod |
|---|---|---|
| Git branch | `staging` | `main` |
| Backend host | Railway service `champutm-production` (rename to `champbeam-test`) | Coolify app `glqeabg3bi476iam4cgbg01g` on 64.227.154.215 |
| Build | `backend/Dockerfile` via `backend/railway.toml` | `backend/Dockerfile` via `deploy/coolify/docker-compose.prod.yml` |
| Deploy trigger | Railway auto-deploy on push to `staging`, "Wait for CI" on | GitHub Actions `deploy-prod` job after the `gate` check passes on `main` |
| Public API host | `champutm-production.up.railway.app` (later `api-test.champbeam.com`) | `share.lakeb2b.com` (Cloudflare) and `champbeam-api.64.227.154.215.sslip.io` |
| Database | Railway Postgres (scrubbed copy of prod, refreshed on demand) | champ-paas Postgres on the box, backed up to R2 |
| Files | `STORAGE_BACKEND=mongo` (Railway Mongo plugin) or R2 bucket `champbeam-files-test` | R2 bucket `champbeam-files` |
| Clerk | development instance, `pk_test_` / `sk_test_` | production instance, `pk_live_` / `sk_live_` |
| Frontend | Vercel preview deployments and the `staging` branch alias | Vercel production from `main`, www.champbeam.com |
| `VITE_API_URL` | Railway host | `https://share.lakeb2b.com` |
| Monitoring | none (it is test) | `deploy/monitor/champ-health.sh` every 2 min, external dead-man check |

## The flow

```
feature branch  ->  PR into staging  ->  CI gate  ->  merge  ->  Railway deploys test
                                                                 Vercel preview (staging alias)
                                                                 run e2e, click around
staging  ->  PR into main  ->  CI gate  ->  merge  ->  Actions calls Coolify webhook  ->  prod
                                                       waits for /health, fails loudly if not
```

1. Branch from `staging`, push, open a PR into `staging`. CI runs pytest,
   vitest, tsc, eslint, the production frontend build and the backend image build.
2. Merge. Railway builds the same Dockerfile prod uses and runs migrations on
   boot. Vercel builds a preview for the branch; the `staging` branch gets a
   stable alias (Vercel -> Project -> Domains -> add `test.champbeam.com`, assign
   to branch `staging`) with `VITE_API_URL` pointing at Railway.
3. Test there. `docs/TESTING.md` has the e2e run against test.
4. Open a PR `staging -> main`. Same gate. Merge only this way (branch
   protection on `main`: require the `gate` check, no direct pushes).
5. The `deploy-prod` job calls the Coolify deploy webhook and polls `/health`
   until the new container answers. Coolify's rolling update keeps the old
   container serving until the new one's healthcheck passes.

Rollback: Coolify -> app -> Deployments -> redeploy the previous one. Migrations
are forward-only, so a rollback across a migration needs `alembic downgrade -1`
in the container first.

## One-time setup, in order

Railway (test):
1. Service Settings -> Source: Root Directory `backend`, branch `staging`.
2. Settings -> Deploy: enable "Wait for CI".
3. Confirm `backend/railway.toml` is picked up (deploy log says "Using Dockerfile").
4. Delete the root `railway.toml`, `Procfile` and root `requirements.txt` in a
   follow-up PR once a staging deploy is green.
5. Rename the service to `champbeam-test`, swap Clerk keys to the dev instance,
   and point its database at a scrubbed copy (see "Refreshing test data").

Coolify (prod):
1. App -> General: build pack Docker Compose, compose file
   `deploy/coolify/docker-compose.prod.yml`, branch `main`.
2. App -> Advanced: Auto Deploy off.
3. App -> Webhooks: copy the deploy webhook URL. Keys & Tokens: create an API
   token. Put both in GitHub repo secrets as `COOLIFY_DEPLOY_WEBHOOK` and
   `COOLIFY_API_TOKEN`; `PROD_HEALTH_URL=https://share.lakeb2b.com/health`.
4. Environment Variables: paste the prod `.env` (the keys the compose file
   references). `WEB_CONCURRENCY` stays `1` on the shared box (see below).

GitHub:
1. Settings -> Branches: protect `main` and `staging`, require the `gate`
   status check, require a PR.
2. Settings -> Environments: create `production` and (optional) require a
   reviewer; that makes the prod deploy job wait for a click.

Vercel:
1. Production environment variables: `VITE_API_URL=https://share.lakeb2b.com`,
   `VITE_CLERK_PUBLISHABLE_KEY=pk_live_...`.
2. Preview environment variables (scope to branch `staging`): Railway host and
   `pk_test_`.
3. The top-level `vercel.json` with a `services` block is not a Vercel schema
   the frontend uses; the project root should be `frontend`, where
   `frontend/vercel.json` holds the SPA rewrite. Check Project -> Settings ->
   Root Directory says `frontend`, then delete the root file.

## Cutover: making Deepify the real prod (one evening, low traffic)

Today `share.lakeb2b.com` is a proxied Cloudflare record to Railway. The VPS
copy has a separate database that is periodically truncated and reloaded. Until
the flip, every link minted by a user goes to the Railway database.

1. Freeze: announce a 30 minute window; nobody creates links or pages.
2. Final sync from Railway into the box's Postgres (DNS_RUNBOOK a0). Then
   re-provision the service user and any `cb_live_` keys that the truncate
   removed, or better, run the sync with `--data-only` on the app tables and
   leave `api_keys` and `users` for the service identity untouched.
3. Files: if Railway still uses Mongo GridFS, copy blobs to R2 first
   (`scripts/` has no tool for this yet; a 40-line boto3 + pymongo script does it).
   If both already use the same R2 bucket, nothing to do.
4. Coolify env: `REDIRECT_BASE_URL=https://share.lakeb2b.com`,
   `PLATFORM_REDIRECT_HOST=share.lakeb2b.com,champbeam-api.64.227.154.215.sslip.io,champutm-production.up.railway.app`.
   Keeping the Railway host in the list means old links whose host is baked in
   keep resolving once DNS moves. Restart.
5. Cloudflare: change the `share.lakeb2b.com` origin to `64.227.154.215`.
   Keep it proxied (orange) and set SSL mode Full (strict); the VPS already has
   a Let's Encrypt cert from `deepify-add-domain.sh`. No grey-cloud step needed.
6. Verify: `/health` from outside shows `server: nginx` instead of
   `x-railway-edge`; create a link in the app; open it; the click shows in analytics.
7. Only now turn Railway into test: point it at `staging`, swap to Clerk dev
   keys, replace its database with a scrubbed copy.

## Test without Railway (cheaper)

`deploy/coolify/docker-compose.test.yml` runs the test stack as a second Coolify
app on Deepify, branch `staging`, with its own throwaway Postgres and Redis,
about 450 MB all in. Railway then has no job and can be deleted. Do this only
after the dev stacks on the box are stopped (capacity report, step 1), since
the box is already paging. If the box stays tight, the same compose file runs
unchanged on a $6 droplet with Coolify pointed at it as a second server.

## Refreshing test data

```bash
pg_dump "$PROD_DATABASE_URL" --no-owner --no-privileges -Fc -f prod.dump
pg_restore -d "$TEST_DATABASE_URL" --clean --if-exists --no-owner prod.dump
psql "$TEST_DATABASE_URL" -c "update users set email = concat('user', id, '@test.invalid');"
psql "$TEST_DATABASE_URL" -c "delete from api_keys;"
```

Clerk dev users will not match prod `clerk_id`s; sign in once on test and use
`scripts/merge_clerk_user.py` to adopt a prod user's rows if you need real data
under your test identity.

## Scaling limits in the code (read before changing WEB_CONCURRENCY)

* `WEB_CONCURRENCY` > 1 or more than one replica duplicates the two background
  loops in `app/main.py` (`expiry_sweeper_loop`, `domain_provision_loop`) and
  the slowapi limiter, which stores counts in process memory. Before scaling
  out: move the loops behind a Redis lock (or a separate `worker` service) and
  give slowapi `storage_uri=settings.redis_url`.
* The slowapi `default_limits` are declared but never enforced (no
  `SlowAPIMiddleware` is added), so there is no rate limiting today. Decide
  whether that is intended before prod takes public traffic at volume.
* DB pool is `pool_size=5, max_overflow=10` per process. Postgres default
  `max_connections=100`; the shared box also serves ChamPDF and the workspace.
  Two workers = up to 30 connections from ChampBeam alone. Fine, but budget it.
* Pages are served from Postgres bytes (`pages_max_bytes` 2 MiB) with the
  tracking snippet injected at serve time. At 50 req/s this is CPU on the app,
  not I/O. The first scaling step is a Cloudflare cache rule for `/p/*` with a
  short TTL, not more workers.
* Click and view tracking writes one row per event. The `link_clicks` and page
  event tables are the growth tables; the snapshot report tracks their size.
