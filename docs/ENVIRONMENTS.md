# Environments

Production is the Cloudflare Worker. A change reaches it by merging to `main` and deploying `worker/` (`npm run deploy`, or Workers Builds with root directory `worker`). CI does not deploy. The workflow in `.github/workflows/ci.yml` runs the Worker tests, the frontend checks, the legacy backend tests, and a legacy image build, then marks `gate`.

Nothing that differs between production and staging is hard-coded as a second app. Wrangler environments spell out their own bindings. Bindings are not inherited from the top-level config. `node worker/scripts/check-env-overlays.mjs` fails if staging or deepify shares the production D1 database or R2 bucket, or if a `TODO_` id is still empty.

| | Production | Staging | deepify overlay | Legacy FastAPI |
|---|---|---|---|---|
| What it is | The live site | A real Cloudflare Worker for rehearsal | Local wrangler rehearsal, not the control plane | Reference implementation |
| Config | top level of `worker/wrangler.jsonc` | `env.staging` | `env.deepify` | `backend/`, `deploy/` |
| Worker name | `champbeam` | `champbeam-staging` | `champbeam-deepify` | none |
| Public host | https://champbeam.com and https://www.champbeam.com | https://staging.champbeam.com | none until you fill `BETTER_AUTH_URL` | only if you run it yourself |
| Database | D1 `champbeam` | D1 `champbeam-staging` | local persisted D1, placeholder id | Postgres |
| Files | R2 `champbeam-files` | R2 `champbeam-files-staging` | local bucket name `champbeam-files-deepify` | disk, GridFS, or S3, via `STORAGE_BACKEND` |
| Auth | Better Auth | Better Auth, non-production identities | Better Auth | Clerk |
| Mail | `send_email` binding `EMAIL` | its own `EMAIL` binding | no binding unless you add one | none in this tree |
| Cron | `*/15` and `*/5` | same schedules | not a managed cron | in-process loops |

`PLATFORM_REDIRECT_HOST`, `BETTER_AUTH_URL`, `FRONTEND_URL`, and `REDIRECT_BASE_URL` on production are `champbeam.com`. Staging uses `staging.champbeam.com` for all four so a password-reset link is on a champbeam.com host.

## What runs where

```
feature branch -> pull request -> CI gate
main -> Worker deploy (Workers Builds, or npm run deploy from worker/)
```

1. Branch from `main`. Open a pull request. CI runs Worker `tsc` and Vitest, the env-overlay check, frontend `tsc`, eslint, Vitest, and the production frontend build, backend pytest, and a Docker build of `backend/` that is not pushed.
2. Merge. Deploy the Worker. The deploy builds `frontend/dist` and uploads it with the Worker. Set `VITE_GOOGLE_CLIENT_ID` for that build if the Google button should show. It is a public client id. Use your own value in the build settings, not in git.
3. Staging, when you need a Cloudflare copy that is not production: `wrangler deploy --env staging` from `worker/`, after that environment's secrets exist. Apply D1 migrations to `champbeam-staging`, not to `champbeam`.
4. deepify does not create hostnames, certificates, or managed cron. Use it to rehearse the bundle with local D1 and R2. Its `database_id` in `wrangler.jsonc` is a placeholder.

Rollback of the Worker is the previous Workers deployment. D1 migrations in this repo are forward-only. A rollback across a migration needs a plan before you apply the migration.

## Local

See the README. Short version: `wrangler dev --port 8799` in `worker/`, `npm run dev` in `frontend/` with `VITE_API_URL=/api/v1`, and `BETTER_AUTH_URL=http://localhost:5173` in `.dev.vars`.

## Legacy stack

`backend/` (FastAPI, Postgres, Redis, Clerk) and `deploy/` (Compose on a VPS) are the previous production path. Railway config at the repo root and under `backend/` starts that app. `CF_REDIRECT_BASE` on a leftover Railway service redirects public traffic to the Worker and leaves `/health` local. Unset it to serve FastAPI again.

Do not treat `docs/DEPLOY-TROUBLESHOOTING.md`, `deploy/DNS_RUNBOOK.md`, or `PRODUCTION_CUTOVER.md` as the current go-live path. Those files describe the retired VPS, Railway, and Clerk setup. Production DNS is the Worker's custom domains on champbeam.com.
