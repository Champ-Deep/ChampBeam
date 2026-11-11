# ChampBeam Intranet (P0 to P2)

The intranet is an invite-only, review-gated file transfer mode of ChampBeam. A member submits a file for a named
recipient. A Reviewer (IT) approves or rejects it, and approved files show up in the recipient's Inbox. Nothing is
emailed. Every step is written to an append-only, hash-chained decision log.

Requirements are in `ChampBeam Intranet BRD.docx`. [INTRANET-BRD-ERRATA.md](INTRANET-BRD-ERRATA.md) lists where the
build differs from it and records the decisions taken on the open questions.
[INTRANET-BLOCKERS.md](INTRANET-BLOCKERS.md) lists what is still open, who owns each item, and how to clear it.

**Runtime: the Cloudflare Worker** (`worker/`, Hono + D1 + R2 + Better Auth), deployed as its own Worker
`champbeam-intranet` with `INTRANET_MODE=true`. In that mode the Worker serves only the intranet API, Better Auth,
`/health`, the blob upload target and the intranet SPA. Every marketing and public route (`/r`, `/f`, `/p`, pages,
UTM, rooms ...) answers 404.

- Deployment steps: [INTRANET-DEPLOY.md](INTRANET-DEPLOY.md).
- Last acceptance run: [INTRANET-P0-ACCEPTANCE.md](INTRANET-P0-ACCEPTANCE.md).
- The first build on the FastAPI `backend/` is kept as the reference implementation:
  [INTRANET-FASTAPI.md](INTRANET-FASTAPI.md).

## Code map (worker)

| File | What |
|---|---|
| `migrations/0009_intranet.sql` | `transfers`, `decision_log` (+ triggers refusing UPDATE/DELETE), `org_review_settings`, `org_invites`, `agent_benchmarks`; `is_reviewer`, `deactivated_at` on memberships |
| `src/intranet/routes.ts` | `/api/v1/intranet/*` |
| `src/intranet/transfers.ts` | Lifecycle: approve, reject, revoke, withdraw, overturn, download claim/consume, access code, sweeper |
| `src/intranet/decisionLog.ts` | Hash chain, atomic "state change + log rows" batches, chain verification |
| `src/intranet/invites.ts` | Invite-only sign-up on Better Auth |
| `src/intranet/scan.ts` | clamd INSTREAM over a Worker TCP socket |
| `src/intranet/reviewAgent.ts`, `benchmark.ts` | Review agent (Clef, Jev, mock) and benchmark |
| `src/intranet/gate.ts` | `INTRANET_MODE` route gate |
| `src/intranet/sweep.ts` | The cron sweeper |
| `frontend/src/intranet/` | The SPA, built with `VITE_APP_MODE=intranet` |

## Configuration (`wrangler.jsonc` env `intranet`, secrets with `wrangler secret put --env intranet`)

| Variable | Value |
|---|---|
| `INTRANET_MODE` | `true` |
| `FRONTEND_URL`, `BETTER_AUTH_URL`, `REDIRECT_BASE_URL` | The intranet origin |
| `BETTER_AUTH_SECRET` (secret) | 32+ random bytes |
| `STORAGE_UPLOAD_SECRET` (secret) | Long random string. Signs upload tokens and download tickets, and keys access-code HMACs |
| `INTRANET_ORG_IDS` | Org ids or slugs allowed to use the intranet. Set it after bootstrap |
| `INTRANET_MAX_FILE_BYTES` | Per-file cap, default 5 GiB. Without R2 S3 credentials, uploads stream through the Worker and are capped at `WORKER_UPLOAD_MAX_BYTES` (100 MB) |
| `MAX_BYTES_PER_USER` | Total stored bytes per person, default 5 GiB (OQ-4) |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` (secrets) | Presigned direct-to-R2 uploads for files over 100 MB |
| `INTRANET_BLOCKED_EXTENSIONS` | Comma list. The default blocks executables and scripts |
| `INTRANET_MAX_EXPIRY_DAYS` | Upper bound for any access window, default 90 |
| `INTRANET_INVITE_TTL_DAYS` | Default 7 |
| `CLAMD_HOST` / `CLAMD_PORT` / `CLAMD_MAX_STREAM_BYTES` / `CLAMD_TIMEOUT_S` | clamd reachable from Cloudflare (for example through a Tunnel). If unset, files are queued and flagged "not scanned" |
| `CLEF_URL` / `CLEF_TOKEN` / `CLEF_TIMEOUT_S` | Local scorer. The agent cannot be switched on until `CLEF_URL` is set |
| `REVIEW_AGENT_EXCERPT_BYTES` | Default 4096. How much of a text file the agent sees in `content_excerpt` mode |
| `JEV_API_KEY` / `JEV_SIGNOFF_REF` / `JEV_URL` / `JEV_MODEL` / `JEV_TIMEOUT_S` | Jev through OpenRouter |
| `GLITCHTIP_DSN` (secret) | GlitchTip project DSN (NFR-7). If unset, errors only go to Workers Logs |

## Access (ACC-1 to ACC-5)

- **First Admin:** `node scripts/intranet-bootstrap.mjs --email <admin> --origin <origin>` creates the org and prints
  an Admin invite link.
- **Invites:** under Administration → Invite a member, an Admin enters an email (with the role, and whether the person
  is a Reviewer) and gets a one-time link that expires in 7 days. Nothing is emailed: the Admin sends the link
  themselves. Only its SHA-256 is stored.
- **Sign-up:** only through `/accept-invite?token=…`. Better Auth's own sign-up route is disabled in intranet mode, and
  its user-create hook refuses any address without a live invite, so neither an email sign-up nor a Google sign-in can
  create an account for someone who was not invited. Better Auth's own org-management routes are disabled too:
  membership changes go through the logged intranet API.
- **Deactivate:** takes effect at once. The person's sessions are deleted, and every intranet request re-reads the
  membership row. Reactivate restores access.
- **Roles:** Admin is `organization_memberships.role = admin`. Reviewer is the app-managed `is_reviewer` flag.

## Lifecycle

`scanning → submitted → in_review → released → consumed | expired | revoked`. The other exits are:

- `→ check_failed`: malware found.
- `→ rejected`: a reason is required.
- `→ withdrawn`: by the submitter, before release.

An undecided submission expires after `hard_expiry_days` (default 7). The sweeper (cron, every 5 minutes) deletes the
blob whenever a file leaves the platform, and the log row stays.

**On D1:** every state change is one conditional `UPDATE` (its `WHERE` clause names the states it may leave),
written in the same atomic batch as its decision-log rows. If the guard matched nothing, nothing is logged. If a log
write fails, the change rolls back. The chain stays linear through a unique `(organization_id, prev_hash)` index:
the loser of a race retries on the new tip.

**One-time downloads (REL-4):** the first request claims the file atomically (`UPDATE … WHERE` no live claim). A
heartbeat holds the claim while the R2 stream runs, and the file is consumed when the stream completes. If the
client drops out, the claim is released so the download can be retried. Browser downloads use a 60-second HMAC
ticket (`POST …/download-ticket`, then `GET /intranet/download/{ticket}`), so a cross-site link cannot spend a
one-time file.

## Malware scanning (SUB-5)

When `CLAMD_HOST` is set, every submission starts in `scanning` and Reviewers don't see it yet. The file is streamed
from R2 to clamd with `INSTREAM` over a Worker TCP socket:

- **Clean:** the file enters the queue.
- **Infected:** the file is refused, deleted and logged as `check_failed`.
- **No verdict** (scanner unreachable, timed out, or the file is over the stream limit): the file enters the queue
  marked "Not scanned", and the agent will never approve it.

The sweeper retries scans that are stuck in `scanning`.

## Reminders (REV-6)

When a submission has waited longer than `reminder_hours` (12 by default, set by the org), the sweeper writes one
`reminder_sent` row. The queue then shows it as Overdue, the Review badge turns red, and Reviewers get a toast.

## Review agent (AGT-1 to AGT-9)

The agent is off by default. An Admin turns it on under Administration → Review settings → Agent, and every change is
logged. Each sweep looks at pending submissions whose wait window (24h by default, clock hours) has passed and that
the agent hasn't evaluated before:

1. **Deterministic checks first.** The scan must be `clean`, the size and type checks must pass, and the sha256 must
   be known and not seen in an earlier submission. Any failure escalates to a human without calling a scorer.
2. **Scoring.** The configured provider runs first, then `clef`. An error or an invalid answer escalates to a human.
3. **Decision.** At or above the threshold (0.95 by default) the agent approves. Below it, the agent escalates. It
   never rejects.

Agent rows carry `actor_type=agent` and `actor_id=agent:<provider>`, plus the provider, model, input mode,
`p_approve`, threshold and the input's SHA-256. A Reviewer can overturn an agent approval until the recipient opens
the file.

The Clef HTTP contract is the same as in [INTRANET-FASTAPI.md](INTRANET-FASTAPI.md). The Worker sends
`POST $CLEF_URL` with `{question, criteria, input}` and expects `{p_approve, reasons, model, version}`.

**Jev** is offered only when `JEV_API_KEY` is set. It always gets metadata only, never `content_excerpt`. The
fallback order is Jev, then Clef, then a human.

## Access code on release (REL-7)

A Reviewer can set a 4 to 8 digit code when approving. The recipient types it before each download, either as
`X-Access-Code` or when the browser ticket is issued. The code is stored as an HMAC; the log records
`access_code: true` and never the code itself. The recipient gets five tries per file per 10 minutes, counted on the
transfer row. Each wrong code writes `access_code_failed`.

## Benchmark

Administration → Agent benchmark queues a run. The cron sweeper processes it (and also starts it straight away on a
best-effort basis). The run replays human approve/reject decisions through the scorer, metadata only, and reports
agreement, false releases and missed approvals across a threshold sweep. No pass mark is computed: the agreement
needed is Deep's call.

## Observability (NFR-7)

Errors go to two places:

- **GlitchTip.** `src/lib/observability.ts` posts a Sentry-protocol envelope to the project in `GLITCHTIP_DSN`.
  It sends unhandled API exceptions (500s), cron and sweeper step failures, review-agent scorer crashes, benchmark
  failures, R2 blob-delete failures, failed download completions, and "clamd unreachable" (as a warning). The SPA
  reports uncaught errors and unhandled promise rejections to `POST /api/v1/intranet/client-errors` (public, at most
  20 per minute per IP, at most 5 per page load), and the Worker forwards them. Sending happens after the response
  (`waitUntil`) with a 5-second timeout, so a GlitchTip outage never fails a request. Before anything leaves the
  Worker, NFR-4 scrubbing removes query strings, emails and file names from storage keys, and replaces ids and tokens
  in URL paths with `:id` and `:token`. Turn it on with `wrangler secret put GLITCHTIP_DSN --env intranet`. No
  redeploy is needed.
- **Grafana.** Every error is also a `console.error`/`console.warn` line in Workers Logs (`observability.enabled` in
  the `intranet` env). Once the Grafana stack is up, add an OTLP destination for it in the Cloudflare dashboard
  (Workers → Observability → Destinations, for example Grafana Cloud's OTLP endpoint for logs and traces). Then
  reference it in `env.intranet.observability.logs.destinations` and redeploy.

## Tests

```
cd worker && npm run test:intranet            # 56 tests: P0 (BRD section 13), P1, P2, NFR-7
cd worker && npx vitest run                   # the rest of the Worker; INTRANET_MODE off, intranet API answers 404
cd frontend && npx vitest run src/intranet    # 16 UI tests
node worker/scripts/intranet-acceptance.mjs --origin <url> [--local]   # BRD section 13 over HTTP against a deployment
```
