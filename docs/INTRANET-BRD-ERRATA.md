# ChampBeam Intranet BRD v1.0: errata against main

The BRD ("ChampBeam Intranet BRD.docx", 2026-11-03) was written against `origin/main` at
migration `026_maxmind_usage`, before PR #53 (`release/consolidated`) merged. This file lists
every claim in it that no longer matches `main` @ `e0538ad`, with the current location, and
says how `feat/intranet-p0` handled it. The docx itself is unchanged.

Line numbers below are for `main` @ `e0538ad`.

## Section 5: reuse map

| # | BRD says | On main now | What the build did |
|---|---|---|---|
| 1 | Base is `backend/` FastAPI | The Cloudflare Worker (`worker/`, Hono + D1 + R2) is the primary runtime; `backend/` is "kept as the reference implementation until cutover" (`README.md:7-8`) | Built on `backend/` anyway, as agreed: OQ-2 wants files on an IT-owned disk, which R2 cannot give. The Worker is untouched and has no intranet routes. |
| 2 | "Main's head is 026_maxmind_usage (no 027+ on main)" | Head was `030_slug_index_ignores_deleted` (027 x2, 028, 029 merge, 030) | New migration is `031_intranet_transfers`, down-revision `030_slug_index_ignores_deleted`. `alembic heads` shows one head. |
| 3 | `consume_link_view` explained at `utm_service.py` lines 364-389 | Method spans `backend/app/services/utm_service.py:364-424`; the atomic `UPDATE … WHERE` is at 394-411. Only `/r` calls it | The one-time gate in `app/services/transfer_service.py` (`claim_download`) uses the same pattern on `transfers`. |
| 4 | Serve path checks `max_views`, then increments around `utm_service.py:503` | Confirmed: check at `backend/app/api/files.py:189`, read-modify-write at `utm_service.py:503`. The Worker has the same race (`worker/src/routes/filesServe.ts:236`, increment in `worker/src/services/utm.ts:508-518`) | Not reused. Intranet downloads never touch `/f`. The marketing serve path still has the race and is not fixed by this branch. |
| 5 | Rate limiting via `backend/app/middleware/rate_limit.py` is "keep as is" | The 100/minute default is inert: no `SlowAPIMiddleware` is installed (`rate_limit.py:15-17`). Only routes decorated with `@limiter.limit` are metered | Intranet upload init and all download routes are decorated with `@limiter.limit("60/minute")`. |
| 6 | Per-user quota `max_bytes_per_user` (5 GiB) | Still `backend/app/core/config.py:161`, enforced only at upload init (`api/v1/files.py:439`); the file replace route skips it | Enforced at intranet upload init. Per-file cap is a new `INTRANET_MAX_FILE_BYTES` (default 5 GiB), because the marketing per-kind caps (`api/v1/files.py:69-75`, 50 MB for "other") are far below the data team's files. |
| 7 | "Invite-only via Clerk organization invitations" (Clerk client is "keep as is") | `backend/app/services/clerk_client.py` has only `fetch_user`, `primary_email`, `full_name`, `verify_webhook`. No invitation support anywhere | Added `create_org_invitation`, `revoke_org_invitation`, `update_org_membership_role`, `delete_org_membership`, plus an `org_invites` table to enforce the 7-day expiry locally. |
| 8 | "Add reviewer as a role value" | `OrganizationMembership.role` (`backend/app/models/org.py:86`) is overwritten from the Clerk JWT on every sync, so an app-assigned role value would be lost | Reviewer is an app-managed boolean `is_reviewer`, like `leader_user_id`. Admin still comes from the Clerk role. |
| 9 | ACC-4: deactivated users lose access at once | Memberships have no status column; the token sync caches for 5 minutes | Added `deactivated_at`. Every intranet request reads the membership row, so deactivation is immediate. |
| 10 | Self-destruct fields on `FileAsset` (`expires_at`, `max_views`, `revoked_at`) set at release | Present, but `FileAsset` has no `organization_id` and `user_id` is nullable (`backend/app/models/file_asset.py:53`) | Limits live on the new `transfers` row, not on `FileAsset`, so the marketing sweeper and serve path cannot act on intranet files. |
| 11 | Expiry sweeper "keep as is" | `expiry_sweeper_loop` only soft-deletes rows by `FileAsset.expires_at` and imported the Postgres session maker at module load | Extended with `sweep_transfers` (released past `expires_at`, undecided past `hard_expires_at`, stale invites), each writing a decision-log row. The session maker is read at call time so tests can patch it. |
| 12 | `frontend/src/pages/FilesPage.tsx` becomes "My submissions" and "Inbox" | Unchanged on main | Left untouched. The intranet UI is a separate app root (`frontend/src/intranet/`) chosen by `VITE_APP_MODE=intranet`, so ChampBeam keeps working. |
| 13 | Feature switches implied by "drop or leave dormant" | No feature flags: every router is mounted unconditionally (`backend/app/main.py:197-217`) and frontend routes are hard-coded | `INTRANET_MODE=true` mounts only health, the Clerk webhook, the intranet router and the blob upload route. `/f`, `/r`, `/p`, UTM, Pages, Rooms, assistant and the API docs are not mounted. |

## Other sections

| Section | BRD says | Reality / decision |
|---|---|---|
| 4 Lifecycle | `approved` then `released` are separate states | With the agent off there is no gap between them, so the transfer moves straight to `released`. Both events are still written to the log. |
| 6.4 REL-4 | "open" = a completed download | Implemented as a lease: the first request claims the download atomically, the claim is held by a heartbeat while bytes stream, and the file is consumed only when the stream finishes. An interrupted download releases the claim and can be retried. |
| 7.1 | No update or delete route on the log | True at the API, and migration 031 also adds a Postgres trigger that rejects `UPDATE`, `DELETE` and `TRUNCATE` on `decision_log`. Rows have no foreign keys, so they outlive the blob, the transfer and the org. |
| 7.1 | Log events are transfer events | The log also records admin actions (invites, member changes, settings), with `transfer_id` empty. AGT-1 needs this for settings changes anyway. |
| 9 NFR-1 | No unauthenticated route returns a blob | Browser downloads use a 60-second HMAC ticket (`POST …/download-ticket`, then `GET /intranet/download/{ticket}`), so multi-GB files stream to disk instead of into memory. The ticket is bound to the user, org, transfer and kind (recipient or review), and the membership is re-checked when it is used. |
| 9 NFR-4 | No file names in logs where avoidable | `check_failed` rows carry the reason and size, not the filename. Invite rows store a SHA-256 of the email. |

## P1 decisions that refine the BRD

- **Clef (OQ-6):** the BRD names the clef MCP server. The backend calls a plain HTTP contract
  instead (see `INTRANET.md`), so Clef can live behind IT's logged gateway without the app being
  an MCP client.
- **Scan without a verdict:** files the scanner can't judge (too large, scanner down) are queued
  for a human, flagged "Not scanned", and the agent can't approve them (AGT-3). Infected files are
  refused at intake.
- **Reminders (REV-6):** in-platform only (`reminder_sent` row, Overdue flag, red badge, toast), in
  line with BRD §8.
- **Lifecycle:** P1 adds a `scanning` state before `submitted`, and `withdrawn` (SUB-6).
- **Escalations** re-notify Reviewers the same way as reminders. An escalated item is not
  re-scored.

## P2 decisions that refine the BRD

- **Access code (REL-7):** the BRD points at `access_control.py` for "5 attempts per 10 minutes".
  That limit is counted in Redis per IP and lets everything through when Redis is down. The
  intranet keeps the HMAC helpers but counts attempts on the `transfers` row, per file, so it
  holds without Redis. Only Reviewers can set the code, at approval; the agent never sets one.
- **Jev sign-off (OQ-9):** built and available whenever the server has `JEV_API_KEY`. IT's
  approval happens at deployment: the key only exists on a server IT runs. The optional
  `JEV_SIGNOFF_REF` is logged when an Admin switches the org to Jev. The agent itself stays off
  by default, as AGT-1 requires.
- **Jev input:** Jev is never given `content_excerpt`. The BRD allows it with IT's written
  agreement. That would need a second, separate sign-off, so it is not built.

## Not in this build (still open)

- Resend one-time links for external recipients (REL-8) are not built. OQ-1 has not confirmed
  that external recipients are in scope.
- Production home for Clef (OQ-6) and IT's choice of scanner (OQ-5). The code works with any
  clamd it can reach.
- Reactivating a member only clears `deactivated_at`. Deactivation also removes the Clerk org
  membership, so the person needs a new invite to sign in again.
