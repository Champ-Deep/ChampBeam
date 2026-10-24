# V3 release: Cloudflare Worker, org-scoped sharing, delegated reporting

Branch `v3/cloudflare-release`, draft PR #42 into `main`. Not merged. Deep approved a
merge only after exact-head tests, security review and `/review` pass (see sections 6 and 7).
Production recovery, DNS, deploys and migrations are gated (section 9).

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
| Cookies | Serve cookies (visitor, access gate) are host-only (no `Domain`), `HttpOnly`, `SameSite=Lax`. The visitor cookie is `Secure` on https; the email/code gate cookies set no `Secure` attribute (finding F3, low: add it when D2 puts the share origin on https only). The signed-in session is a bearer token, not a cookie, so there is no ambient credential to ride. | `routes/filesServe.ts` `starletteCookie(...)` | Pass (source read) |
| Legacy active content on the app origin | When `SHARE_ORIGIN_HOSTS` is set, legacy `/f` and `/p` HTML and SVG/XML on platform hosts 302 to the share origin with the same path, so old links survive. While it is unset, they still serve on the app origin. | `filesServe.ts` redirect block | Conditional on D2 |
| SVG and MIME confusion | Upload kinds are mapped from an explicit MIME allowlist; `image/svg+xml` is not in it, so it becomes `other`, which always downloads. `nosniff` and `Referrer-Policy: no-referrer` are sent on every serve. | `_files.ts` `MIME_KIND`, `commonHeaders` | Pass (source read) |
| Hostile HTML | HTML gets a CSP (`default-src 'self'`, no external script, `frame-ancestors 'none'`, `base-uri 'self'`) but `script-src 'unsafe-inline'` is allowed on purpose. A hostile page can therefore run script on the share origin. Scope is the share origin only, with no control plane and no bearer token there. | `HTML_CSP` | **Finding F1, accepted risk pending D3** |
| Cross-tenant read on a shared share origin | Because pages from different owners share one origin, script in one tenant's page can `fetch` another tenant's page path on that origin; a visitor who already unlocked a gated page sends its host-only cookie, so the body is readable. Public pages are public anyway; gated pages are the exposure. Mitigation is a CSP `sandbox` (opaque origin) which would change legacy behaviour, so it was NOT applied. | `HTML_CSP`, gate cookies | **Finding F2, needs-validation, decision D3** |
| Slug collision and takeover | Slug is unique per host namespace; org domains serve only what was shared on them; reserved words and traversal are rejected by `validateSlug`; a changed slug leaves an alias and a freed slug stays reserved, so an old URL cannot be re-pointed to a different page. | `services/pages.ts`, `orgShares.test.ts` | Pass (fixture) |
| Tombstones and stale sessions | Revoked membership is re-read from D1 on every request; a still-valid token loses org access and cannot revive the row; only a Clerk webhook re-add lifts it. Reporting grants are re-read per request and revoked with the membership. | `services/org.ts`, `services/reporting.ts`, `orgShares.test.ts`, `orgReporting.test.ts` | Pass (fixture) |
| Reporting authorization | Scope is derived server side; `team` and `user` filters narrow inside it and out-of-scope ids are 403; cross-org, API key, viewer-without-grant and revoked-grant paths are tested; eight mutations of the guard logic each fail the suite. | `orgReporting.test.ts` | Pass (fixture) |
| Cache leakage | Serve responses are `Cache-Control: private, max-age=300`; the Worker keeps no shared response cache. A CDN rule in front must key on host and respect `private`. | `commonHeaders` | Needs-validation on the real edge |
| Range, expiry, max views, R2 object authorization | Pre-existing serve tests cover range, expiry and gates. No object is reachable except through the asset lookup by host and code or slug. | `serveFiles.test.ts` | Pass (fixture) |
| SSRF (URL import) | No fetch-and-host-a-copy endpoint exists in this release, so there is no SSRF surface to review. Required controls are listed in D4 and must be reviewed when it is built. | grep of outbound `fetch(` in `src/` | Not applicable yet |
| Automated scanners | CodeQL did not report on this head and Cloudflare preview is failing (section 7). | PR checks | **needs-validation, not passed** |

Not run here, so not claimed: the project `security-audit` skill gate and CodeQL (sandbox and
CI constraints), a live TLS and hostname check, a live Clerk webhook.

## 7. Gates at this head

| Gate | Result |
|---|---|
| Worker typecheck (`npx tsc --noEmit`) | clean |
| Worker tests (`cd worker && npx vitest run`, Node 22) | 31 files, 407 passed (392 before Step 6, +15 in `orgReporting.test.ts`) |
| Backend (`cd backend && python -m pytest tests -q`, clean venv, no Postgres) | 190 passed |
| Frontend (`tsc -b` via `npm run build`, `npx vitest run`, `npm run lint`) | build ok, 32 passed, eslint 0 errors and 60 warnings (pre-existing floating-promise warnings, untouched) |
| Inventory script test (`python worker/scripts/test_page_inventory.py`) | 1 passed |
| Coverage | not measured (no coverage provider is configured for the Workers pool) |
| Mutation checks on the new reporting guards | 8 of 8 mutations fail the suite |
| GitHub `ci` (pytest, frontend, image, gate), Vercel | green on the previous head 7fe7c9a; re-read at the final head |
| Workers Builds: champbeam | **FAILURE on 7fe7c9a, cause not readable** (below). Success on #41. |
| CodeQL | no result on this head: needs-validation |
| Cloudflare preview | failing: needs-validation |

Workers Builds failure. The build log lives behind the Cloudflare dashboard (build
`148e4664-fc06-426b-a9b0-c6bd0175c4b6`) and needs an authenticated session; the GitHub check
run carries only the build id and no annotations. I did not use stored credentials to pull
it. Local reproduction on the same tree with Node 22: `npm run build:frontend` (npm ci, `tsc
-b`, `vite build`) exits 0 and `wrangler deploy --dry-run` bundles and lists the expected
bindings. So the failure is NOT a compile, lockfile or config-parse error that reproduces
offline. Unproven candidates: the dashboard build is wired to deploy the production Worker
`champbeam` (a non-production branch should not), a missing build-time variable, or an
account-side step. Treat red as red; no pass claim is made on the preview.

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
| D9 | Production page recovery | Needs read-only prod access (capability), then inventory, backup, restore | Hold | n/a |

Also not done in this release (UI lives on the dependent frontend card): composer intent
toggle, domain picker, slug field, org switch cache clear, account menu. Live Clerk webhook
and a real org-domain TLS check are not done. Existing preparatory runbook in Celsus
`Projects/Champbeam/ops/2026-10-24 Cloudflare Cutover Runbook.md` is preparation, not proof.

## 10. New environment surface (names only)

`SHARE_ORIGIN_HOSTS`. No other variable is added in this release.
