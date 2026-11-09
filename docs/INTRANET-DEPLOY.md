# Deploying the ChampBeam Intranet on Cloudflare

Status (2026-11-10): the code is ready, and the P0 acceptance checklist passes 10/10 on a local deployment
(`docs/INTRANET-P0-ACCEPTANCE.md`). It has not been deployed to Cloudflare yet. No Cloudflare account was available,
and the `intranet` environment in `worker/wrangler.jsonc` still has two `TODO_` placeholders. Follow the steps below
in order. The commands run from `worker/`.

## What gets created

| Resource | Name | Notes |
|---|---|---|
| Worker | `champbeam-intranet` | A separate Worker from production `champbeam`. `INTRANET_MODE=true` |
| D1 | `champbeam-intranet-db` | Its own database. Never shared with production (`scripts/check-env-overlays.mjs` enforces this) |
| R2 | `champbeam-intranet-files` | File bytes. Private bucket, no public access |
| Cron | `*/5 * * * *` | Sweeper: expiry, stale invites, reminders, scan retries, review agent, benchmarks |

## Steps

1. **Log in.** Run `npx wrangler login` with the account that should own the intranet (Deep's account
   `deep-ae0` hosts production today). Check it with `npx wrangler whoami`.
2. **Create the database and bucket.**
   ```
   npx wrangler d1 create champbeam-intranet-db
   npx wrangler r2 bucket create champbeam-intranet-files
   ```
   Copy the printed `database_id` into `env.intranet.d1_databases[0].database_id` in `wrangler.jsonc`, replacing
   `TODO_intranet_d1_id`.
3. **Pick the origin.** Without a custom domain the origin is `https://champbeam-intranet.<account-subdomain>.workers.dev`.
   Put it in `FRONTEND_URL`, `BETTER_AUTH_URL` and `REDIRECT_BASE_URL` under `env.intranet.vars`, replacing
   `TODO_intranet_origin`. A custom domain (for example `intranet.champions...`) can be added later as a Worker
   route. If you add one, update these three values and redeploy.
4. **Secrets.**
   ```
   npx wrangler secret put BETTER_AUTH_SECRET --env intranet      # 32+ random bytes
   npx wrangler secret put STORAGE_UPLOAD_SECRET --env intranet   # 32+ random bytes; signs upload tokens, download tickets, access codes
   ```
   Optional, add them when needed:
   - `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`: an R2 API token for the bucket. Without it, uploads
     stream through the Worker and are capped at 100 MB (the plan's request-body limit). With it, browsers upload
     straight to R2 and the cap is `INTRANET_MAX_FILE_BYTES` (5 GiB). The bucket then needs a CORS rule that allows
     `PUT` from the intranet origin.
   - `CLAMD_HOST` / `CLAMD_PORT`: a clamd reachable from Cloudflare, for example through a Cloudflare Tunnel.
     Without it, files are queued and flagged "Not scanned".
   - `CLEF_URL` / `CLEF_TOKEN`: the local scorer's HTTP endpoint, needed before the review agent can be switched on.
   - `JEV_API_KEY` (and `JEV_SIGNOFF_REF`): makes Jev available. The agent stays off until an Admin turns it on.
5. **Migrate.** Run `npm run db:migrate:intranet`. It applies `0001` to `0009`, and `0009_intranet.sql` adds the
   intranet tables and the `decision_log` append-only triggers.
6. **Deploy.** Run `npm run deploy:intranet`. It checks the overlay (refuses while any `TODO_` is left), builds the
   SPA with `VITE_APP_MODE=intranet` into `frontend/dist-intranet`, then runs `wrangler deploy --env intranet`.
7. **Seed the first Admin (ACC-1).**
   ```
   node scripts/intranet-bootstrap.mjs --email <it admin email> --origin <intranet origin>
   ```
   This creates the organization "Champions Group" (slug `champions-intranet`) and prints a one-time invite link.
   Send it to the first Admin. They open it, choose a password, and from then on invite everyone else from
   Administration. To lock the deployment to this org, put its id in `INTRANET_ORG_IDS` and redeploy.
8. **Run the P0 acceptance checklist against the live Worker.**
   ```
   node scripts/intranet-acceptance.mjs --origin <intranet origin> --report ../docs/INTRANET-P0-ACCEPTANCE.md
   ```
   It creates its own throwaway org ("Acceptance xxxx"). The REL-3 check waits for the 5-minute cron.

## Local deployment (what the acceptance report was run on)

```
cp .dev.vars.example .dev.vars.intranet      # then set FRONTEND_URL/BETTER_AUTH_URL/REDIRECT_BASE_URL=http://127.0.0.1:8798,
                                             # INTRANET_MODE=true, BETTER_AUTH_SECRET, STORAGE_UPLOAD_SECRET
npm run build:frontend:intranet
CI=1 npm run db:migrate:intranet:local
npm run dev:intranet                         # wrangler dev --env intranet --port 8798 --test-scheduled
node scripts/intranet-bootstrap.mjs --email you@example.com --origin http://127.0.0.1:8798 --local
node scripts/intranet-acceptance.mjs --origin http://127.0.0.1:8798 --local
```

## Notes

- Sign-in is Better Auth with email and password. Google can be added with `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`
  and a `VITE_GOOGLE_CLIENT_ID` frontend build variable. A Google sign-in still only works for an invited address.
- No email is sent. Invite links are shown to the Admin once. There is no self-service password reset yet, because
  that needs an email sender (Resend, OQ-1/REL-8).
- Files live in R2, in the account that owns the Worker. The BRD's OQ-2 recommendation was an IT-owned disk. That was
  overruled on 2026-11-09 in favour of Cloudflare (see `INTRANET-BRD-ERRATA.md`).
