# ChampBeam Intranet (P0)

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

Frontend build: `VITE_APP_MODE=intranet`, `VITE_API_URL=<backend origin>`, `VITE_CLERK_PUBLISHABLE_KEY`.

Run `alembic upgrade head` to apply `031_intranet_transfers`. It adds the tables and a Postgres
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

`submitted → in_review → released → consumed | expired | revoked`, or `→ rejected` (a reason is
required). An undecided submission expires after `hard_expiry_days` (default 7). The sweeper
deletes the blob when a file is rejected, revoked, consumed or expired. The log row stays.

## Tests

```
cd backend && python -m pytest -q -p no:cacheprovider tests/test_intranet.py
cd frontend && npx vitest run src/intranet
```
