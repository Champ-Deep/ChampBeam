# V3 release: Cloudflare Worker, org-scoped sharing, delegated reporting

Branch `v3/cloudflare-release`, draft PR #42 into `main`. Not merged. Deep approved a
merge only after exact-head tests, security review and `/review` pass (see sections 6 and 7).
Production recovery, DNS, deploys and migrations are gated (section 9).

This head is the unified release candidate: PR #44 (single composer UI) and PR #43 (wrangler
env overlays) are merged in, and the rulings on F3, D3, D7 and D10 are applied (sections 6, 7, 9, 11).

Source of truth for scope: Celsus `Efforts/Active/Champ Harbinger/2026-10-24 - Product and
Cloudflare Execution Spec.md`, sections 1 to 4.1.

## 1. Merits and containment

Every remote branch is an ancestor of this branch. Proof, run on the exact head:

```bash
git fetch --all --prune
for b in $(git branch -r | grep -v HEAD | grep -v v3/ | sed 's/^ *//'); do
  git merge-base --is-ancestor $b HEAD && echo "contained $b" || echo "MISSING $b"
done
```

| Branch | PR | Ahead of main | Verdict | Reason |
|---|---|---|---|---|
| `main` | | 0 | base | Release is cut from it. |
| `v2-consolidation` | #40 (open) | 19 | land (carried, Step 1) | Supersedes #28, #35, #38. Pages V2, assistant, environments as code, issues #37 and #30. |
| `cloudflare` | #41 (open) | 10 | land (carried, Step 2) | The Hono + D1 + R2 Worker port. Now the runtime this release targets. |
| `feat/pages-v2-links-assistant` | #28 (open) | 3 | close, superseded by #40/#42 | Commits are inside v2-consolidation, verified by ancestry. |
| `ops/environments-and-ci` | #35 (open) | 4 | close, superseded by #40/#42 | Same. CI workflow and environments docs ride in via #40. |
| `feature/issues-37-30` | #38 (open) | 3 | close, superseded by #40/#42 | Same. API key creation and project analytics fixes. |
| `feat/one-composer-ui` | #44 (open) | 9 on top of the pre-RC release head | land (carried, RC step 1) | Single composer and scoped sharing workspace. Merged with `--no-ff`, no conflicts. Contained after this head. |
| `ops/cf-env-overlays` | #43 (open) | 1 on top of the pre-RC release head | land (carried, RC step 2) | Wrangler env overlays `deepify` and `staging` plus `check-env-overlays.mjs`. Merged with `--no-ff`; `wrangler.jsonc` auto-merged, then RC step 3 made `assets.run_worker_first` identical in every env (#44 added the root-slug list at top level, #43 overlays had the old route list) and made the overlay check enforce it. Contained after this head. |
| `claude/friendly-turing-tiwr9b` | #26 (merged) | 0 | nothing to land | Already in main. Safe to delete after Deep's go. |
| `claude/gracious-johnson-a8vcfn` | none | 0 | nothing to land | Fully behind main. Safe to delete after Deep's go. |
| `preview/deepify-backend` | none | 0 | nothing to land | Fully behind main (Aug 14). Safe to delete after Deep's go. |
| `feat/file-download-mode` (local only, shared checkout) | none | 16 + uncommitted | carried by diff (Step 3) | The 16 commits are the v2 line; the uncommitted download-mode diff and `test_file_disposition.py` were carried as Step 3 and the shared checkout was not touched. |

Nothing is closed or deleted by this PR. Closing the superseded PRs and deleting branches is
Deep's explicit go, after the containment command above is re-run on the merge candidate.

## 2. What the release adds on top of the carried work

| Step | Content |
|---|---|
| 1 | Merge `v2-consolidation`. |
| 2 | Merge `cloudflare` (Worker port). |
| 3 | File download mode (`?dl=1`, attachment for non-viewable types). |
| 4 | Explicit permission map (`worker/src/auth/permissions.ts`) replacing `role.endsWith("admin")`. Membership revocation is a tombstone. Migration `0002`. |
| 5 | Org domains, share-origin isolation, root-slug hosting, download/host intent, slug aliases, slug suggestion. |
| 6 | Delegated reporting: viewer grants, scoped summary, profile context, org domain admin endpoints, page inventory script, this document. |

Behaviour changes to know about: unique-slug collisions number (`name-2`) instead of a
random suffix, and a freed slug stays reserved (aliases) so an old URL cannot be re-pointed.

## 3. Permission map

Reporting visibility is not a role. A viewer is any member holding a grant.

| Capability | Member | Team lead | Org admin (IT) | Viewer role | Any member + grant |
|---|---|---|---|---|---|
| `share.create` | yes | yes | yes | no | unchanged |
| `report.own` | yes | yes | yes | no | unchanged |
| `report.team` / `team.manage` | no | yes | yes | no | unchanged |
| `report.org` | no | no | yes | no | via org-scope grant, read only |
| `org.members.manage` | no | no | yes | no | no |
| `org.domains.manage` | no | no | yes | no | no |
| `org.viewers.grant` | no | no | yes | no | no |

Unknown Clerk roles fall back to member, never admin (`billing_admin`, `superadmin` are not
admin). API keys carry no org context, so they get no org permission and no reporting.
Platform operator is not a customer role: there is deliberately no code path that gives it
implicit access to private assets (see section 9, decision D5).

Deep as "sudo admin view" is an org-scope grant on a member (or `viewer` role) seat. It adds
read-only reporting and nothing else; it does not make him IT admin and shares no credential.

## 4. API contract for the composer and UI

Auth is a Clerk session bearer unless noted. All paths are under `/api/v1`. Errors use
`{"detail": ...}`.

### 4.1 Create a resource (intent)

| Intent | Call | Result |
|---|---|---|
| Send as a file | `POST /files` with `{"intent":"download", ...}`, PUT bytes, finalize | Files. `/f/<code>`. Always `Content-Disposition: attachment`. |
| Host for viewing | `POST /files` with `{"intent":"host", ...}` or `POST /pages` for HTML | Pages. `https://<share-host>/<slug>`. Inline viewer. |
| Track an external link | existing `POST /utm/...` | Links. `/r/<code>`. |

`intent` is optional. Omitted means legacy behaviour (nothing changes for old clients and old
links). Responses carry `intent`, `output_kind` (`file` or `page`), `slug`, `public_url`.
URL import (fetch and host a copy) is NOT in this release; see D4.

### 4.2 Slug suggestion

`GET /pages/slug-suggestion?filename=Quarterly%20Brief.pdf&domain_id=<optional>`

```json
{"slug":"quarterly-brief","base":"quarterly-brief","collided":false,"host":"share.example.com","public_url":"https://share.example.com/quarterly-brief"}
```

Read only, reserves nothing. On collision `slug` is `quarterly-brief-2` and `collided` is true.
`POST /pages` takes optional `slug` and `domain_id`; a taken slug is 409, a reserved or
malformed one is 400. A title edit never changes the slug.

### 4.3 Profile context and host picker

`GET /org/profile` (any signed-in caller, API keys included)

```json
{"user_id":"...","email":"a@b.c","full_name":"...","org":{"id":"org_...","name":"...","slug":"..."},
 "role":"admin","permissions":["org.domains.manage","..."],"report_scope":"org",
 "share_host":{"default":"share.lakeb2b.com","default_domain_id":"..."},
 "available_hosts":[{"id":"...","hostname":"...","org_default":true}]}
```

No org selected: `org`, `role` null, `permissions` empty, `report_scope` `none`.
`report_scope` is `org`, `team`, `own` or `none`. The UI must clear its caches when the
active org changes; the server recomputes everything per request.

### 4.4 Org domains

| Call | Who | Notes |
|---|---|---|
| `GET /org/domains` | any org member | Members see only `active`; admins also see pending. |
| `POST /org/domains/{id}/attach` | `org.domains.manage` | Admin attaches a verified domain they own. Explicit, never automatic. Another org's domain is 409. |
| `POST /org/domains/{id}/default` | `org.domains.manage` | Active org domain only. One default per org (partial unique index). |

A request body that names another tenant's domain id is refused on every create path.
Unverified domains never produce a working-looking URL.

### 4.5 Reporting viewers

| Call | Who | Notes |
|---|---|---|
| `GET /org/viewers` | `org.viewers.grant` | Live grants in the active org. |
| `POST /org/viewers` | `org.viewers.grant` | `{"user_id","scope":"org"}` or `{"user_id","scope":"team","leader_user_id"}`. Target must be an active member; team leader must be an active leader or admin. Identical live grant returns 200 with the same id; new is 201. |
| `DELETE /org/viewers/{id}` | `org.viewers.grant` | Revokes. 204, idempotent. A grant of another org is 404. |

### 4.6 Reporting summary

`GET /org/reporting/summary?team=<leader id>&user=<member id>&kind=file|page|link&from=<iso>&to=<iso>`

```json
{"scope":"team","filters":{"team":null,"user":null,"kind":null,"from":null,"to":null},
 "totals":{"shares_created":3,"opens":4,"clicks":2},
 "emails_sent":{"status":"not_measured","count":null,"note":"..."},
 "by_kind":{"file":{"shares_created":0,"opens":0,"clicks":0},"page":{"...":0},"link":{"...":0}},
 "by_member":[{"user_id":"...","full_name":"...","shares_created":0,"opens":0,"clicks":0}]}
```

Definitions: `shares_created` is rows created in the window under the org; `opens` is views of
a file or page; `clicks` is clicks on a tracked link. `emails_sent` is always `not_measured`:
Beam mints links, it does not send mail, and a count needs a provider event id from the
Harbinger/provider integration. Filters only narrow inside the caller's own scope: an
out-of-scope `team` or `user` is 403, never silently widened. Personal (non-org) assets are
excluded. Timestamps are compared as stored ISO-8601 UTC text; legacy rows in another format
may sort off at the window edge (see D8).

## 5. Page disappearance: cause analysis and inventory status

**Status: inventory UNPROVEN.** No authorized read-only production access (Railway
Postgres, live D1, R2 listing) was available to this run, and none was attempted with
guessed credentials. Nothing below is a finding about production.

The standby ends 7 Sep and misses 95 declared blobs, so it is never used as the entire
production source. The inventory must be run per source (Railway, live D1, standby) and
diffed; "row only in one source" and "row present, blob absent" are reported separately.

Hypotheses that the code supports, each with the check that confirms or kills it:

| # | Hypothesis | Code evidence | Check |
|---|---|---|---|
| H1 | Ownership split. Lists filter on `file_assets.user_id` of the CURRENT Clerk identity (`GET /pages`, `GET /files`). A second Clerk identity maps to a second `users` row via `getOrCreateByClerkId`, so earlier items are hidden, not deleted. | `routes/pages.ts` list, `routes/files.ts` list, `backend/scripts/merge_clerk_user.py` exists for the same problem. | Inventory buckets: same email-hash owner tags appearing as two owner tags with disjoint rows. |
| H2 | Legacy HTML under Files. `GET /files` lists every kind including `html`; `output_kind` falls back to "page if slug else file". Old uploads with no slug look like Files. | `routes/_files.ts` `outputKind`. | `summary.legacy_html_under_files` and `summary.html_without_version_row`. |
| H3 | Row present, blob missing. Serve returns 404/502 for a row whose R2 object was never copied (standby misses 95). | Serve path reads `storage_key` from R2. | `summary.active_rows_missing_blob` with `--blobs` from the live bucket listing. |
| H4 | Active org change. Org switching changes the session org, not the owner filter, so this alone should not hide pages; verify instead of assuming. | List queries are user scoped, not org scoped. | Compare the screenshot account's owner tag before and after org switch. |
| H5 | Frontend cache key or filter mismatch (Links badge 3 vs empty recent widget). Not a data problem. | Frontend card scope. | Browser console and network capture on the dependent frontend card. |

Run it (read only; the SQLite file is opened `mode=ro`, output is counts and salted hash tags only):

```bash
python worker/scripts/page_inventory.py d1.sqlite --source d1 --blobs r2-keys.txt --salt "$SAME_SALT" > d1.json
python worker/scripts/page_inventory.py standby.sqlite --source standby --salt "$SAME_SALT" > standby.json
python worker/scripts/test_page_inventory.py    # redaction and counting test
```

A source must first be exported to SQLite by someone with the access (D1: `wrangler d1
export --remote`; Postgres: the existing `export_postgres_to_d1.py` output loaded into
SQLite). Restore only after a backup, from the authoritative source, preserving ids, share
codes, `/f` and `/p` addresses, versions and analytics. Never regenerate pages to fill a list.

## 6. Hosted-content isolation: source-specific security review

Reviewed in source at this head. Test evidence is fixture based (in-memory D1/R2, test-signed
Clerk JWT). No live Clerk, DNS, TLS or Cloudflare was exercised.

| Area | Finding | Evidence | Verdict |
|---|---|---|---|
| Control plane on the share origin | On a share plane (`SHARE_ORIGIN_HOSTS` or an org-owned verified domain) only `/f /p /r /s /rooms`, `/api/pages/`, `/health` and root slugs resolve; SPA and `/api/v1` return 404. | `lib/shareOrigin.ts`; `orgShares.test.ts` | Pass (fixture) |
| Cookies | Serve cookies (visitor, access gate) are host-only (no `Domain`), `HttpOnly`, `SameSite=Lax`. The visitor cookie is `Secure` on https; the email gate cookies on `/r` and `/f` now set `Secure` whenever the request scheme is https (X-Forwarded-Proto first, else the URL scheme) and stay plain on http for local `wrangler dev` (finding F3, fixed, tested for both schemes). The signed-in session is a bearer token, not a cookie, so there is no ambient credential to ride. | `routes/filesServe.ts` `starletteCookie(...)` | Pass (source read, F3 fixed) |
| Legacy active content on the app origin | When `SHARE_ORIGIN_HOSTS` is set, legacy `/f` and `/p` HTML and SVG/XML on platform hosts 302 to the share origin with the same path, so old links survive. While it is unset, they still serve on the app origin. | `filesServe.ts` redirect block | Conditional on D2 |
| SVG and MIME confusion | Upload kinds are mapped from an explicit MIME allowlist; `image/svg+xml` is not in it, so it becomes `other`, which always downloads. `nosniff` and `Referrer-Policy: no-referrer` are sent on every serve. | `_files.ts` `MIME_KIND`, `commonHeaders` | Pass (source read) |
| Hostile HTML | HTML gets a CSP (`default-src 'self'`, no external script, `frame-ancestors 'none'`, `base-uri 'self'`) but `script-src 'unsafe-inline'` is allowed on purpose. A hostile page can therefore run script on the share origin. Scope is the share origin only, with no control plane and no bearer token there. | `HTML_CSP` | **Finding F1: mitigated for pages created after the `HTML_SANDBOX` flag (default on), still open for legacy pages until the owner opts in (section 6.1)** |
| Cross-tenant read on a shared share origin | Because pages from different owners share one origin, script in one tenant's page can `fetch` another tenant's page path on that origin; a visitor who already unlocked a gated page sends its host-only cookie, so the body is readable. Public pages are public anyway; gated pages are the exposure. Mitigation is a CSP `sandbox` (opaque origin), applied per page (section 6.1). | `HTML_CSP`, `HTML_SANDBOX`, gate cookies | **Finding F2: closed for sandboxed pages, open for legacy pages** |
| Slug collision and takeover | Slug is unique per host namespace; org domains serve only what was shared on them; reserved words and traversal are rejected by `validateSlug`; a changed slug leaves an alias and a freed slug stays reserved, so an old URL cannot be re-pointed to a different page. | `services/pages.ts`, `orgShares.test.ts` | Pass (fixture) |
| Tombstones and stale sessions | Revoked membership is re-read from D1 on every request; a still-valid token loses org access and cannot revive the row; only a Clerk webhook re-add lifts it. Reporting grants are re-read per request and revoked with the membership. | `services/org.ts`, `services/reporting.ts`, `orgShares.test.ts`, `orgReporting.test.ts` | Pass (fixture) |
| Reporting authorization | Scope is derived server side; `team` and `user` filters narrow inside it and out-of-scope ids are 403; cross-org, API key, viewer-without-grant and revoked-grant paths are tested; eight mutations of the guard logic each fail the suite. | `orgReporting.test.ts` | Pass (fixture) |
| Cache leakage | Serve responses are `Cache-Control: private, max-age=300`; the Worker keeps no shared response cache. A CDN rule in front must key on host and respect `private`. | `commonHeaders` | Needs-validation on the real edge |
| Range, expiry, max views, R2 object authorization | Pre-existing serve tests cover range, expiry and gates. No object is reachable except through the asset lookup by host and code or slug. | `serveFiles.test.ts` | Pass (fixture) |
| SSRF (URL import) | No fetch-and-host-a-copy endpoint exists in this release, so there is no SSRF surface to review. Required controls are listed in D4 and must be reviewed when it is built. | grep of outbound `fetch(` in `src/` | Not applicable yet |
| Automated scanners | CodeQL did not report on this head and Cloudflare preview is failing (section 7). | PR checks | **needs-validation, not passed** |

### 6.1 Hosted HTML sandbox (D3, ruled A)

Flag `HTML_SANDBOX` (env var, default on). Column `file_assets.html_sandbox` (migration `0003`,
nullable): `NULL` legacy, `1` sandboxed, `0` owner opted out. A page is served with
`sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox` appended to the
existing CSP only when its column is `1` AND the flag is on. New HTML created through
`POST /api/v1/pages` or the `/files` intent flow gets `1` while the flag is on; seeded legacy rows
stay `NULL`; `PATCH /api/v1/pages/{id}` with `html_sandbox` is the owner opt-in or opt-out. Setting
`HTML_SANDBOX=off` is the kill switch: nothing is sandboxed and new pages are not marked.

Because the page now has an opaque origin, its requests carry `Origin: null` and no cookies. CORS
therefore allows `null` ONLY on `/api/pages/*` (Beam State, page token auth) and
`/f/<code>/page-events` (dwell beacon); every other route still refuses it (tested). `X-Beam-Token`
is added to the allowed request headers.

Proof (real Chromium via Playwright against local `wrangler dev`, fresh local D1 with 0001 to 0003,
page that calls `beam.state.set/get` and `beam.comments.add`, then leaves the page):

| Check | Sandboxed new page | Opted-out page |
|---|---|---|
| CSP header contains `sandbox` | yes | no |
| Beam State set, get, comment add | all succeed through CORS | succeed |
| Dwell beacon reaches the server | yes, `total_dwell_ms` 847 | yes, 833 |
| `document.cookie` | SecurityError | works |
| `localStorage` | SecurityError | works |
| Console errors | none | none |

What breaks under the sandbox, by design: `document.cookie`, `localStorage`, `sessionStorage` and
IndexedDB throw; a page that reads its own cookies or persists to browser storage must use
`beam.state` instead; top-level navigation from inside the page (`target=_top`) and downloads
without a user gesture are blocked; the visitor cookie is not sent by the page, so the dwell
beacon identifies the visitor from the `visitor_id` it carries in the body (the server already
supported that fallback). The first page load still sets the visitor cookie because that is a
top-level navigation. Mutation checks: removing the null-origin gate, widening it to all paths and
removing the sandbox header each fail `htmlSandbox.test.ts`. Not verified: other browsers, and
real pages in the wild that rely on storage (legacy pages are untouched for that reason).

Not run here, so not claimed: the project `security-audit` skill gate and CodeQL (sandbox and
CI constraints), a live TLS and hostname check, a live Clerk webhook.

## 7. Gates at this head (unified release candidate)

Run locally on the merged tree, Node 22 (Worker, frontend) and a clean Python 3.11 venv (backend):

| Gate | Result |
|---|---|
| Worker typecheck (`cd worker && npx tsc --noEmit`) | clean |
| Worker tests (`npx vitest run`) | 34 files, 426 passed (422 on the merged tree before the F3 and D3 work; +4 in `htmlSandbox.test.ts`; F3 assertions added inside `serveRedirect.test.ts` and `serveFiles.test.ts`) |
| Overlay isolation (`node worker/scripts/check-env-overlays.mjs`) | OK; fails when an overlay `run_worker_first` differs from the top level (shown by mutation) |
| Backend (`cd backend && python -m pytest tests -q`) | 190 passed |
| Frontend (`npx tsc -b`, `npm run lint`, `npx vitest run`, `npm run build`) | tsc clean, eslint 0 errors and 54 warnings (pre-existing floating-promise warnings), 81 tests passed in 11 files, build ok |
| Inventory script test | 1 passed |
| Fresh local D1 | migrations 0001, 0002, 0003 apply cleanly with `wrangler d1 migrations apply champbeam --local` |
| Mutation checks | F3 (drop `secure`) fails `serveRedirect.test.ts`; D3 (drop null-origin path gate, widen it, drop the sandbox header) each fail `htmlSandbox.test.ts` |
| Real-browser sandbox probe | section 6.1 |
| GitHub `ci` (backend, frontend, worker, image, gate), Vercel, Workers Builds | read on the exact pushed head in the task handoff; the head SHA cannot be written into this file |
| CodeQL | no result on this repo's PR checks: needs-validation |
| Coverage | not measured (no coverage provider is configured for the Workers pool) |

Worker tests are now a CI gate: job `worker (tsc, vitest)` (D10, ruled A) runs `npm ci`,
`tsc --noEmit`, the overlay check and `vitest run` on Node 22, and `gate` needs it.

## 8. Test fixture boundary

Passed against: migrated in-memory D1, in-memory R2, a test-key-signed Clerk JWT, seeded rows.
Not verified live: real Clerk org and webhook events, DNS, TLS and SaaS hostname activation,
real R2 listing and copy, production data, rollback.

## 9. Gated decisions (nothing here is done or assumed)

Format: DECISION; A (recommended); B; C hold. Default if silent: hold. Reply A on the task.

| Id | Decision | A (recommended) | B | C |
|---|---|---|---|---|
| D1 | Apply migration `0002` to remote D1 | After a D1 backup, apply to a clone first, then remote | Apply straight to remote | Hold |
| D2 | Provision the share origin (`SHARE_ORIGIN_HOSTS`, custom domain, TLS) | Provision `share.champbeam.com` first, verify, then set the var | Use only org domains | Hold |
| D3 | Hostile-HTML hardening: CSP `sandbox` on hosted HTML (closes F2, may break pages that use same-origin state) | A: ship behind a flag, test the Beam State and dwell beacons, default on for new pages only | B: leave as is, accept F2 for gated pages | C hold |
| D4 | URL import (fetch and host a copy) | Build later with HTTPS only, public-IP check after DNS, redirect recheck, byte and time limits, MIME check, user confirmation | Skip import | Hold |
| D5 | Platform operator support scope | Separate audited path, no implicit asset access | None for now | Hold |
| D6 | Close superseded PRs #28 #35 #38 and delete the three fully-merged branches | After Deep approves the merge candidate and the ancestry check passes | Close but keep branches | Hold |
| D7 | Workers Builds on this branch | Read the dashboard log, then fix or disable non-production builds | Leave | Hold |
| D8 | Normalize legacy timestamps before reporting windows | Run a one-off normalization after backup | Accept edge skew | Hold |
| D10 | The `ci` workflow has no Worker job: the 407 Worker tests, the Worker typecheck and the dry-run bundle are not a CI gate, so a green PR says nothing about the Worker | Add a `worker` job (Node 22: `npm ci`, `tsc --noEmit`, `vitest run`) and require it in the `gate` job | Leave as local-only | Hold |
| D9 | Production page recovery | Needs read-only prod access (capability), then inventory, backup, restore | Hold | n/a |

### 9.1 Rulings applied in the unified RC (2026-10-25)

| Id | Status | What was done or why it stays held |
|---|---|---|
| D1 | **Hold, Deep-owned** | Remote D1 untouched. Migration `0003` now also needs to be applied with `0002` before the Worker code is deployed: the code selects `file_assets.html_sandbox`, so deploying it onto a D1 without 0003 fails every asset query. Order: backup, clone, `0002`, `0003`, then deploy. |
| D2 | **Hold, Deep-owned** | No share origin provisioned. F3 is fixed independently of it. |
| D3 | **Done, ruled A** | Section 6.1. Flag `HTML_SANDBOX`, default on for new pages, legacy off until the owner opts in. |
| D4 | **Hold** | Not built. |
| D5 | **Hold** | Not built. |
| D6 | **Hold** | Nothing closed or deleted, including #28, #35, #38, #43, #44. |
| D7 | **Done as far as possible, ruled A** | Section 11. Cause not readable from here, fixes and the exact dashboard check named. |
| D8 | **Hold** | No normalization run. |
| D9 | **Hold, Deep-owned** | No production access used. |
| D10 | **Done, ruled A** | Worker CI job added and required by `gate` (section 7). |
| F3 | **Fixed** | Section 6, Cookies row. |

Also not done in this release (UI lives on the dependent frontend card): composer intent
toggle, domain picker, slug field, org switch cache clear, account menu. Live Clerk webhook
and a real org-domain TLS check are not done. Existing preparatory runbook in Celsus
`Projects/Champbeam/ops/2026-10-24 Cloudflare Cutover Runbook.md` is preparation, not proof.

## 10. New environment surface (names only)

`SHARE_ORIGIN_HOSTS`, `HTML_SANDBOX` (default on; `off` disables the hosted HTML sandbox everywhere). No other variable is added in this release. Schema: migration `0003_html_sandbox.sql` (one nullable column).

## 11. Production gating and Workers Builds

Workers Builds (Cloudflare git integration for Worker `champbeam`, check name `Workers Builds:
champbeam`) fails on PR #42 and PR #44 heads. It succeeded on #41.

What was established:

- The GitHub check run carries only a build id and no annotations (`gh api .../check-runs`). The
  log is behind the Cloudflare dashboard session. `wrangler` has no builds command, and an
  automated read of the log through stored credentials was not permitted in this unattended run, so
  the exact failure text is NOT known. Do not read this section as a diagnosis.
- Offline, on the merged tree with Node 22: `npm ci`, `tsc --noEmit`, `npm run build:frontend`
  (`tsc -b`, `vite build`) and `wrangler deploy --dry-run` all succeed (bundle 1567 KiB, gzip 310 KiB,
  5 asset files). `wrangler.jsonc`, the worker `package.json` and the lockfile are byte-identical
  between #41 and the pre-RC #42, so a config or dependency change does not explain red-vs-green.
  What differs between #41 and #42 is source, frontend source and migration `0002`.
- The check URL is `.../workers/services/view/champbeam/production/builds/...`: the integration is
  attached to the PRODUCTION Worker.

Ranked hypotheses to check in the dashboard (Workers & Pages, `champbeam`, Settings, Builds). None is
proven:

1. The Build or Deploy command includes `wrangler d1 migrations apply champbeam --remote`. #41 had
   only `0001` (already applied, a no-op) so it passed; #42 adds `0002`, so the build would try to
   change the remote D1, and fail or, worse, succeed. This fits "red only on the branch with a new
   migration" and it collides with decision D1. Remove the migration step from the build.
2. A build-time variable used by the frontend build (`VITE_*`) is set in Vercel but not in the
   Workers Builds environment. The frontend build does not fail without it today (verified), so this
   is unlikely.
3. Node version. CI and local use 22; set `NODE_VERSION=22` in the build variables to match.

Production gating. If the integration's production branch is `main`, merging PR #42 to `main` will
build and deploy the production Worker with no further approval. That is the default behaviour of
Workers Builds and the dashboard was not read, so treat it as UNVERIFIED but assume it is true.
Proposed settings, to be changed by Deep (this PR changes no dashboard setting):

- Set the integration's production branch to a dedicated branch (for example `production`) that only
  Deep updates, so merging to `main` deploys nothing.
- Turn off non-production branch builds (D7 option A), or keep them only if the build command is
  `wrangler versions upload` with no migration step.
- Deploy production from a manual `workflow_dispatch` job or by hand with `wrangler deploy`, after
  D1 (backup, clone, `0002`, `0003`) is done.

Until one of these is set, the safe assumption is that a merge to `main` is a production deploy.

## 12. LakeB2B org migration (run order)

Moves every existing user and their content into one Clerk organization. Run per environment, staging first. Never against production before the production D1 load (runbook P7, P8) has finished.

1. Create the `LakeB2B` organization in the Clerk dashboard with Deep as admin. Copy its `org_...` id. Confirm Clerk organizations are enabled on the instance and the plan's members-per-org cap covers the user count.
2. Dry run, then apply (from `worker/`). `BEFORE` is the switch instant, ISO UTC. Re-runnable, existing members are skipped.
   ```
   CLERK_SECRET_KEY=... ORG_ID=org_... BEFORE=2026-10-26T00:00:00.000Z node scripts/clerk_bulk_membership.mjs
   CLERK_SECRET_KEY=... ORG_ID=org_... BEFORE=2026-10-26T00:00:00.000Z node scripts/clerk_bulk_membership.mjs --apply
   ```
3. Wait for the Clerk webhooks to write the `organizations` and `organization_memberships` rows (check `members` in step 5 equals the script's `eligible`).
4. Run the backfill SQL. It only moves content whose owner is a member and was created before `:before`, and it touches rows still NULL, so it is safe to repeat. A wrong org id writes nothing.
   ```
   sed -e 's/:org_id/org_.../g' -e 's/:before/2026-10-26T00:00:00.000Z/g' scripts/lakeb2b_org_backfill.sql > /tmp/backfill.sql
   npx wrangler d1 execute <db> --remote --file /tmp/backfill.sql
   ```
5. Verify: run the final `SELECT` of the SQL file with `--command`. Expect `members` = eligible users, `org_files` and `org_links` = their content, `org_default_domains` = 1 once `share.lakeb2b.com` is in `domains`. If the domain row does not exist yet, run the SQL again after it is created.
