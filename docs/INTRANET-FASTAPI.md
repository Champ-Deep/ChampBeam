# ChampBeam Intranet on FastAPI (reference implementation)

> This is the first build of the intranet, on the FastAPI `backend/`. The runtime that gets deployed is the
> Cloudflare Worker: see [INTRANET.md](INTRANET.md) and [INTRANET-DEPLOY.md](INTRANET-DEPLOY.md). This file is kept
> for the backend code (`backend/app/api/v1/intranet.py`, migrations 031 to 033), which stays as a reference.

An invite-only, review-gated file transfer mode of ChampBeam. A member submits a file for a
named recipient. A Reviewer (IT) approves or rejects it, and approved files show up in the
recipient's Inbox. Nothing is emailed. Every step is written to an append-only, hash-chained
decision log. Requirements are in `ChampBeam Intranet BRD.docx`; see
[INTRANET-BRD-ERRATA.md](INTRANET-BRD-ERRATA.md) for where the build differs from it.

It runs on the FastAPI `backend/`, not the Cloudflare Worker, so files stay on an IT-owned disk.

## Configuration

Backend (`backend/.env`):

| Variable | Value |
|---|---|
| `INTRANET_MODE` | `true`. Mounts only `/health`, `/api/v1/webhooks/clerk`, `/api/v1/intranet/*` and the blob upload route |
| `STORAGE_BACKEND` / `STORAGE_LOCAL_PATH` | `local` and a path on durable, IT-controlled disk |
| `STORAGE_UPLOAD_SECRET` | Long random string. Signs upload tokens and download tickets |
| `INTRANET_ORG_IDS` | Comma-separated Clerk org ids allowed to use the intranet. Set this, or any Clerk org could sign in |
| `INTRANET_MAX_FILE_BYTES` | Per-file cap, default 5 GiB. `MAX_BYTES_PER_USER` still caps total stored bytes per person (OQ-4) |
| `INTRANET_BLOCKED_EXTENSIONS` | Comma list. Default blocks executables and scripts |
| `INTRANET_MAX_EXPIRY_DAYS` | Upper bound for any access window, default 90 |
| `INTRANET_INVITE_TTL_DAYS` | Default 7 |
| `INTRANET_INVITE_REDIRECT_URL` | Where Clerk sends an invitee after accepting, e.g. `https://intranet.example/sign-in` |
| `CLERK_SECRET_KEY`, `CLERK_WEBHOOK_SECRET` | Required: invites and member changes call the Clerk Backend API |
| `CLAMD_HOST` / `CLAMD_PORT` | clamd TCP address (port default 3310). Unset means files are queued flagged "not scanned" |
| `CLAMD_MAX_STREAM_BYTES` | Default 25 MiB, which is clamd's own `StreamMaxLength` default. Raise both together to scan larger files |
| `CLAMD_TIMEOUT_S` | Default 120 |
| `CLEF_URL` / `CLEF_TOKEN` | The local scorer's HTTP endpoint and optional bearer token. The agent cannot be switched on until `CLEF_URL` is set |
| `CLEF_TIMEOUT_S` | Default 20. A timeout escalates to a human; it is never read as approval |
| `REVIEW_AGENT_EXCERPT_BYTES` | Default 4096. How much of a text file the agent sees in `content_excerpt` mode |
| `JEV_API_KEY` | OpenRouter key for Jev. Setting it makes Jev available to Admins; clearing it stops Jev at once, even if the org setting still says `jev` |
| `JEV_SIGNOFF_REF` | Optional. Reference to IT's approval of Jev (ticket id, or email date and sender). When set, it is recorded in the decision log whenever an Admin switches to Jev |
| `JEV_URL` / `JEV_MODEL` | Default `https://openrouter.ai/api/alpha/decisions` and `typesafe/jev-1.13` |
| `JEV_TIMEOUT_S` | Default 20. A timeout falls back to Clef, then a human |

Frontend build: `VITE_APP_MODE=intranet`, `VITE_API_URL=<backend origin>`, `VITE_CLERK_PUBLISHABLE_KEY`.

Run `alembic upgrade head` to apply `031_intranet_transfers`, `032_intranet_p1` and `033_intranet_p2`. It adds the tables and a Postgres
trigger that rejects `UPDATE`/`DELETE`/`TRUNCATE` on `decision_log`.

## Clerk setup (manual, one time)

1. Use a Clerk instance dedicated to the intranet.
2. **User & authentication → Restrictions → Sign-up mode: Restricted.** Only invited emails can create accounts (ACC-1, ACC-3).
3. **Organizations:** turn off "Allow users to create organizations". Create the org yourself and copy its id into `INTRANET_ORG_IDS`.
4. Add the first admin to the org with role `org:admin` in the dashboard. From then on, admins invite people from **Administration** in the app.
5. Point a webhook at `/api/v1/webhooks/clerk` for `user.*`, `organization.*` and `organizationMembership.*`.

## Roles

- **Admin** (Clerk `org:admin`): invites and deactivates members, assigns Reviewer and Admin, and changes review settings.
- **Reviewer** (set in-app): sees the queue, opens files and approves or rejects them. A Reviewer cannot decide their own submission.
- **Member**: submits files, sees their own submissions and receipts, and receives released files.

## Lifecycle

`scanning → submitted → in_review → released → consumed | expired | revoked`. Other exits:
`→ check_failed` (malware found), `→ rejected` (reason required), `→ withdrawn` (by the submitter
before release). An undecided submission expires after `hard_expiry_days` (default 7). The sweeper
deletes the blob whenever a file leaves the platform. The log row stays.

## Malware scanning (SUB-5)

When `CLAMD_HOST` is set, every submission starts in `scanning`, and reviewers don't see it yet.
The file is streamed to clamd with `INSTREAM`:

- **Clean:** the file enters the queue.
- **Infected:** the file is refused, deleted and logged as `check_failed`.
- **No verdict** (scanner unreachable, timed out, or the file is over the stream limit): the file
  enters the queue marked "Not scanned", and the agent will never approve it.

The sweeper retries scans that are stuck in `scanning` (for example after a restart).

## Reminders (REV-6)

When a submission has waited longer than `reminder_hours` (12 by default, set by the org), the
sweeper writes one `reminder_sent` row. The queue then shows it as Overdue, the Review badge turns
red, and Reviewers get a toast. Reminders are in-platform only; nothing is emailed.

## Review agent (AGT-1 to AGT-9)

The agent is off by default. An Admin turns it on with Administration → Review settings → Agent:
Local scorer, and every change is logged. Each time the sweeper runs, it looks at pending
submissions whose wait window (24h by default, clock hours) has passed and that it hasn't looked at
before:

1. **Deterministic checks first:** the malware scan must be `clean`, the size and type checks must
   pass, the sha256 must be known and not seen in an earlier submission. Any failure escalates to a
   human without calling the scorer.
2. **Scoring:** the configured provider runs, then `clef` as the fallback. If every provider errors
   or returns an invalid answer, the submission is escalated.
3. **Decision:** at or above the threshold (0.95 by default) the agent approves and releases with
   the submitter's requested limits. Below it, the agent escalates. It never rejects.

Agent rows are logged with `actor_type=agent` and `actor_id=agent:<provider>`, plus provider,
model, input mode, `p_approve`, threshold and the input's SHA-256. A Reviewer can overturn an agent
approval (Review queue → "Approved by the agent") until the recipient opens the file.

### Clef HTTP contract

The backend sends `POST $CLEF_URL` with header `Authorization: Bearer $CLEF_TOKEN` (if set) and
this body:

```json
{
  "question": "Should IT release this internal file transfer without a human review?",
  "criteria": [{"name": "business_purpose", "question": "..."}, ...],
  "input": {"filename": "...", "size_bytes": 123, "mime_type": "...", "submitter": {"name": "...", "email": "..."},
            "recipient": {...}, "purpose": "...", "requested_expires_in_days": 7, "requested_one_time": false,
            "hard_checks": {...}, "malware_scan": "clean", "input_mode": "metadata_only",
            "content_excerpt": "first N bytes (content_excerpt mode, text files only)"}
}
```

It expects `200` with `{"p_approve": 0.0-1.0, "reasons": ["..."], "model": "...", "version": "..."}`.
Anything else counts as an error. A thin wrapper around the clef MCP tools (`decide` /
`clef_ask`) can expose this.

### Jev (P2)

Jev is available as soon as the server sets `JEV_API_KEY`. IT approves Jev by approving the
deployment that carries the key; put their reference in `JEV_SIGNOFF_REF` so it lands in the log.
The agent is still off by default: an Admin picks "Jev, metadata only" under Administration →
Review settings → Agent. The fallback order is Jev, then Clef, then a human.

- Jev always gets metadata only: file name, size, type, submitter and recipient names and emails,
  purpose, requested limits and check results. It never gets `content_excerpt`, whatever the org
  setting says (AGT-5). That data leaves the company network through OpenRouter.
- The backend sends one batched request to `JEV_URL`: `{"model", "state": <metadata>, "questions"}`,
  with one `noul` question named `release` plus one per criterion. `p_approve` is the probability
  Jev gives to `release`. The per-criterion probabilities go into `reasons`. A missing or
  out-of-range `release` answer counts as an error.
- The benchmark can replay decisions through Jev too (`--provider jev`, or pick it in the app),
  which sends the metadata of past submissions to OpenRouter.

## Access code on release (REL-7)

When approving, a Reviewer can set a 4 to 8 digit access code, or click "Generate code". The
recipient then has to type the code before each download. The code is stored as an HMAC keyed by
`STORAGE_UPLOAD_SECRET`, never in plain text, and the Reviewer gives it to the recipient themselves
(by phone or chat): nothing is emailed. The approval log row records `"access_code": true`, never
the code.

- Five tries per file in 10 minutes, counted in the database, after which the download answers
  `429` until the window passes. A correct code resets the counter. Each wrong code writes an
  `access_code_failed` row.
- Browser downloads check the code when the ticket is issued
  (`POST …/download-ticket` with `{"access_code": "…"}`). API clients send it as `X-Access-Code`
  on `GET …/download`. A ticket issued before a code was set does not bypass it.
- Only the recipient is asked. The submitter can still open their own file.

## Benchmark

Before the agent goes on live traffic, run the benchmark. It replays human approve and reject
decisions from the decision log through the scorer, metadata only, and reports agreement, false
releases and missed approvals across a sweep of thresholds. No pass mark is computed: the agreement
needed is Deep's call. There are two ways to run it:

- In the app: Administration → Agent benchmark → Run benchmark. The report can be downloaded as Markdown.
- On the server: `python scripts/benchmark_review_agent.py --org org_XXXX --provider clef --out-dir ./benchmarks`
  writes JSON and Markdown.

## Tests

```
cd backend && python -m pytest -q -p no:cacheprovider tests/test_intranet.py tests/test_intranet_p1.py tests/test_intranet_p2.py
cd frontend && npx vitest run src/intranet
```
