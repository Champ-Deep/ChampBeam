# Intranet P0 acceptance run (BRD section 13)

- Target: `https://champbeam-intranet.deep-ae0.workers.dev` (Cloudflare, remote D1 and R2)
- Run: 2026-11-11T11:27:44.926Z, org `8f630a99-aac7-44f5-888f-537cb45f99e1`
- Script: `worker/scripts/intranet-acceptance.mjs`. Every person was created through an invite link; every step went through the HTTP API.
- Result: **10/10 passed**

| # | BRD | Check | Result | Evidence |
|---|---|---|---|---|
| 1 | ACC-3 | An email that was never invited cannot sign up or call any route | PASS | sign-up 404, invite-accept with a made-up token 404, sign-in 401, /intranet/me without a session 401, users rows for that email: 0 |
| 2 | SUB-2 | An unapproved file returns 403 to the recipient, and to every other member | PASS | recipient 403, admin 403, reviewer via the recipient route 403, recipient inbox 0 items |
| 3 | NFR-1 | An unauthenticated request to any file path returns 401 or 404, never bytes | PASS | /api/v1/intranet/transfers/{id}/download -> 401; /api/v1/intranet/review/{id}/file -> 401; /api/v1/intranet/transfers/{id} -> 401; /api/v1/intranet/log.csv -> 401; /api/v1/intranet/download/dHJhbnNmZXIuMzE5OWViNjYtZGJjNS00Zj -> 404; /f/abc -> 200; /r/abc -> 200 |
| 4 | REV-4 | A Reviewer cannot approve their own submission | PASS | approve own 403 (You cannot decide your own submission.); reject own 403 |
| 5 | REL-4 | Ten parallel downloads of a one-time file yield exactly one success | PASS | statuses 200,410,410,410,410,410,410,410,410,410; winner got the exact bytes: true; state consumed; an 11th try 410 |
| 6 | REL-3 | After expires_at the file is refused and the blob is gone after the sweep | PASS | download after expiry 410; after the sweep: transfer expired, file row deleted, R2 object not found |
| 7 | REL-5 | A revoked file is refused at once | PASS | download before 200, revoke 200, download right after 410 (This file was revoked.) |
| 8 | REV-3 | Reject without a reason is refused | PASS | no reason / empty / blank -> 422, 422, 422; with a reason 200; the submitter sees "Contains customer PII" |
| 9 | REL-6 | The submitter sees Not opened, then Opened with a time | PASS | before: not_opened; after the recipient's download: opened at 2026-11-11T11:26:39.361Z |
| 10 | 7.1 | Every state change produced a decision-log row, and no API route can edit or delete one | PASS | 7 transfers, 38 log rows, missing events: none; hash chain verify ok=true over 38 rows; direct SQL UPDATE refused: true, DELETE refused: true (trigger: decision_log is append-only); write methods on /log and /log/{id}: 404,404,404,404,404,404,404 |
