# ChampBeam Intranet: open blockers

Updated 2026-11-11. The intranet is live at https://champbeam-intranet.deep-ae0.workers.dev, and the BRD section 13
acceptance checklist passes 10/10 against it (`INTRANET-P0-ACCEPTANCE-LIVE.md`). None of the items below stops people
from using it. Each one is a feature that stays off, or a limit that stays in place, until the owner acts. Commands run
from `worker/`.

## Inputs from people outside the build

| # | Blocker | Owner | Until it clears | To clear it | Status |
|---|---|---|---|---|---|
| B1 | R2 API token for `champbeam-intranet-files` | Deep | Uploads stream through the Worker and are capped at 100 MB | `wrangler secret put R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY --env intranet`, then add a bucket CORS rule that allows `PUT` from the intranet origin | Open |
| B2 | IT sign-off on file storage in Cloudflare R2 (NFR-2, OQ-2) | Nandish, raised by Deep | Files already live in R2 on Deep's account. The BRD recommended an IT-owned disk, and this has not been formally accepted | A written OK from IT. No code change | Open |
| B3 | ClamAV (clamd) host reachable from Cloudflare (SUB-5, OQ-5) | Nandish | Every file shows "Not scanned", and reviewers decide without a scan | Expose clamd, for example through a Cloudflare Tunnel, then `wrangler secret put CLAMD_HOST --env intranet` (and `CLAMD_PORT` if it isn't 3310) | Open |
| B4 | Home for the Clef scorer (AGT, OQ-6) | Deep, Chief | The review agent cannot be switched on, so every file is reviewed by hand | `wrangler secret put CLEF_URL --env intranet` and `CLEF_TOKEN`. An Admin then turns the agent on in Administration | Open |
| B5 | Agent pass mark | Deep | Even with Clef connected, nobody has decided what benchmark agreement is good enough to let the agent decide | Run Administration → Agent benchmark, and Deep picks the threshold | Blocked by B4 |
| B6 | Jev API key (OQ-9) | Nandish | Jev is not offered as a scorer | `wrangler secret put JEV_API_KEY --env intranet` and `JEV_SIGNOFF_REF` | Open |
| B7 | GlitchTip DSN (NFR-7) | Deep (stack owner) | Errors go only to Cloudflare Workers Logs | `wrangler secret put GLITCHTIP_DSN --env intranet`. No redeploy needed | Waiting for the stack |
| B8 | Grafana OTLP endpoint (NFR-7) | Deep (stack owner) | Logs can be read in the Cloudflare dashboard only | Add an OTLP destination under Workers → Observability, reference it in `env.intranet.observability.logs.destinations`, redeploy | Waiting for the stack |
| B9 | Admin handover to IT (ACC-1) | Harshil, Nandish | Harshil is the only Admin | Harshil invites Nandish as Admin and Reviewer from Administration. Nandish then decides whether Harshil keeps Admin | Open |
| B10 | Custom domain (optional) | Deep | The app is served on `*.workers.dev` | Add a Worker route, set `FRONTEND_URL`, `BETTER_AUTH_URL` and `REDIRECT_BASE_URL` to it in `wrangler.jsonc`, redeploy | Optional |

## On the build side

| # | Item | Status |
|---|---|---|
| E1 | Pull request from `feat/intranet-cloudflare` to `main` | Not opened yet. Harshil opens it |
| E2 | Throwaway "Acceptance" orgs left in the live database by the acceptance runs | Harmless: `INTRANET_ORG_IDS` locks them out. Delete them if a clean database is wanted |

## Not built in v1, by decision

| Item | Why | What it needs |
|---|---|---|
| REL-8, one-time links for people outside the company | OQ-1 ruled members only for v1 | An email sender (Resend) and a new decision on OQ-1 |
| Self-service password reset | No email sender. An Admin re-invites anyone locked out | The same email sender |
| One-year decision-log pruning (OQ-7) | The log is append-only by design. Pruning was ruled an operator job | A runbook, if IT wants rows older than a year removed |

## Done on 2026-11-11

- Cloudflare access: wrangler logged in to Deep's account. The D1 database, R2 bucket, secrets and cron are in place.
- First Admin seeded (Harshil). The deployment is locked to the "Champions Group" org.
- NFR-7 built: the GlitchTip reporter and the SPA error intake. It turns on with B7 and B8.
