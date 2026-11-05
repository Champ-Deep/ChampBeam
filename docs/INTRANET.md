# ChampBeam Intranet (P0 + P1)

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

Frontend build: `VITE_APP_MODE=intranet`, `VITE_API_URL=<backend origin>`, `VITE_CLERK_PUBLISHABLE_KEY`.

Run `alembic upgrade head` to apply `031_intranet_transfers` and `032_intranet_p1`. It adds the tables and a Postgres
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
`clef_ask`) can expose this. Jev is not wired in yet (P2, needs IT's written sign-off).

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
cd backend && python -m pytest -q -p no:cacheprovider tests/test_intranet.py tests/test_intranet_p1.py
cd frontend && npx vitest run src/intranet
```
