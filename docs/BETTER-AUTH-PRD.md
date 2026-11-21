# ChampBeam on Cloudflare: replace Clerk with Better Auth, migrate Clerk accounts

> Decision record. This migration has shipped. Production sign-in is Better Auth on the Worker. `CLERK_*` settings are inert. Setup steps are in [CLOUDFLARE_DEPLOY.md](../CLOUDFLARE_DEPLOY.md), not in the plan below.

Status: shipped. Better Auth is the production sign-in path. The sections below are the plan as written on 5 Nov 2026, including options that were not taken.

## 0. Recommendation (read this first)

Go with Better Auth on the existing Worker (option A in section 9, D1). Do not buy Clerk Pro.

Reason, from Clerk's pricing page read on 5 Nov: the $20 plan is **Pro** ($20/mo billed annually,
$25/mo monthly). Pro does **not** change the members-per-organization cap. The cap is set by the
B2B add-on: the free tier allows 20 members per org on every plan, and unlimited members needs
the **Enhanced B2B add-on at $100/mo ($85/mo billed annually)**. So the $20 plan buys nothing this
migration needs, and the free plan already gives the same 20-member cap. The earlier $100 quote
on t_c556799d was the add-on, not a plan, and both numbers are still correct.

Better Auth costs $0 in licence, has no member cap, and all its data sits in the D1 we already
run. The real cost is engineering: a rewrite of the auth core (4 worker files, 5 call sites),
14 frontend files on `@clerk/react`, an import script, and a fresh security audit.

If people need to sign in on Cloudflare before Better Auth ships, the bridge is the Clerk
**free** plan with keys set (Q4 on t_7a001972). Each target org must have 20 members or fewer.
Users created through that bridge are keyed by `clerk_id`, and the import (section 6) matches on it,
so the bridge does not create migration debt.

## 1. Facts this plan stands on (all probed 5 Nov)

| Fact | Evidence |
|---|---|
| Production D1 `champbeam` is empty: 0 users, 0 orgs, 0 memberships, 0 links, 0 click events, 0 files, 0 API keys | `wrangler d1 execute champbeam --remote` count query |
| Staging D1: 1 user (no clerk_id), 4 link_clicks, 4 click_events, nothing else | same query on `champbeam-staging` |
| Real data still lives in Railway Postgres and loads into D1 through `worker/scripts/export_postgres_to_d1.py` (runbook P7/P8) | script header; `PRODUCTION_CUTOVER.md` section C |
| Clerk production has 38 users (20 championsmail.com, 11 gmail.com, 7 other; 17 signed in within 30 days), organizations disabled, member limit 5 | t_c556799d (Clerk MCP, 30 Oct). Not re-checked here; the triage card re-reads it |
| Every content table links to the local `users.id` (UUID), never to a Clerk id | `worker/src/db/schema.ts`, 19 `references(() => users.id)` columns (section 5) |
| Clerk ids sit in exactly 3 columns | `schema.ts:30` users.clerk_id, `:47` organizations.clerk_org_id (NOT NULL), `:63` organization_memberships.clerk_membership_id |
| The Clerk **org** id travels at runtime as `TokenData.orgId` | `worker/src/auth/security.ts:33`; read at `routes/_org.ts:30`, `routes/orgReporting.ts:46`, `routes/org.ts:129`, `routes/champvault.ts:226,274`, set at `auth/serviceAuth.ts:105` |
| Clerk dashboard CSV export includes `password_digest` (bcrypt) and `password_hasher` on **every plan, free included**. OAuth links are not in the CSV; they come from the Backend API `external_accounts` | clerk.com/docs/guides/development/migrating/overview; clerk.com/articles/clerk-pricing-explained. **The card's premise ("no hashes on free") is wrong.** |
| Removing Clerk empties two secret fallbacks: upload signing falls back to `CLERK_SECRET_KEY` (`env.ts:219`), and access codes fall back to that, then to the literal `"champbeam-access-code"` (`lib/accessControl.ts:119`) | grep. Flagged to the PR #52 audit (t_5a04f003). This plan makes `STORAGE_UPLOAD_SECRET` mandatory |
| Users cascade: deleting a `users` row deletes that user's links, files, API keys, presets, projects, domains and tags (`onDelete: "cascade"`) | `schema.ts:61,107,126,144,160,186,231,309` |
| The old Python merge script reassigns only 9 of the 19 user columns | `backend/scripts/merge_clerk_user.py:39-49` |
| Workers Free gives 10 ms CPU per request; Paid ($5/mo per account) gives 30 s and 30M CPU ms per month included. Password hashing needs Paid | developers.cloudflare.com/workers/platform/pricing (updated 2 Oct 2026). The account's plan is **not verified** |
| No email sender exists in the Worker today (Resend was removed in the earlier cutover) | `grep -ri resend\|smtp worker/src` returns nothing; `PRODUCTION_CUTOVER.md:90` |

## 2. Goal and non-goals

Goal: on both Workers (`champbeam-staging` first, then `champbeam`), people sign in through Better
Auth with the same methods Clerk gives them today. Every approved Clerk user lands on their
existing `users.id`, so their links, files, click data and org ownership keep working. Approved
org users sit in the right org (Champions Group or LakeB2B) with the right role, or stay personal
(Deep's account and anyone approved as personal).

Non-goals: MFA, passkeys, SAML/enterprise SSO, SCIM, a self-serve "create organization" button,
Better Auth's admin plugin, impersonation, changing `cb_live_` API keys or `X-Service-Key`,
changing `permissions.ts`, dropping the Clerk columns (that waits for the rollback window to end,
section 7), the Postgres to D1 data load itself (owned by the Railway migration and runbook P7/P8).

## 3. Shoot holes: what breaks, what is ambiguous

1. **Cookies bring CSRF.** Today the SPA sends a Clerk bearer token, so `/api/v1` mutations cannot
   be forged cross-site. With a session cookie they can. Requirement R6 below: every cookie-authed
   non-GET `/api/v1` request must carry an `Origin` that is in the trusted list, else 403.
2. **Hosted HTML on the app origin.** Pages with `html_sandbox` null (legacy, sandbox off) run user
   HTML. If any of them is served on the same origin as the app, that HTML can call the API with the
   viewer's cookie. The auth audit (C6) must prove where hosted HTML is served and that it cannot
   reach `/api/v1` with credentials.
3. **Two identities for one person.** Clerk dev and prod give one person two different `clerk_id`s
   (`PRODUCTION_CUTOVER.md` H2), so Postgres may hold two `users` rows for one email. Better Auth
   needs one row per email. The import reports these and never merges on its own. A merge must
   rewrite all 19 columns in section 5, not the 9 the Python script covers.
4. **"Remove test accounts" is destructive in D1.** Deleting a `users` row cascades into their
   data. A dropped account is simply not imported (no Better Auth `account` row, `is_active=0`).
   No row is deleted, and nothing is deleted in Clerk.
5. **Email-code-only Clerk users** (no password, no Google/Microsoft) cannot sign in without email
   delivery. The triage counts them. If the count is above 0, D2 (email sender) is required before
   cutover.
6. **The Clerk build is no real rollback today.** Neither Worker has `CLERK_SECRET_KEY`, so rolling
   back to the Clerk build returns to "nobody can sign in". Section 7 says this plainly.
7. **CPU limits.** bcrypt (cost 10, pure JS) and scrypt both blow through 10 ms. Confirm Workers Paid
   on the account before any deploy (C3 acceptance check).
8. **Better Auth `organization.slug` is required and unique**, but ours is nullable. Better Auth
   `user.name` is required, but `full_name` is nullable. Migration 0006 and the import backfill both.
9. **`clerk_org_id` is NOT NULL.** Better Auth does not know the column. Decision: drizzle
   `$defaultFn(() => crypto.randomUUID())` on that column, so orgs Better Auth creates get a
   placeholder. C3 proves it in a test. If the drizzle adapter does not apply `$defaultFn`, 0006
   rebuilds `organizations` with the column nullable (`PRAGMA defer_foreign_keys=on`).

## 4. Design (decided; C3 implements, C6 audits)

Library: `better-auth`, latest 1.7.x at build time, pinned exact. `bcryptjs` (pure JS) only to
verify imported Clerk hashes. Docs used: Context7 `/better-auth/better-auth`, plus the official
Clerk migration guide (better-auth.com/docs/guides/clerk-migration-guide).

| Area | Decision |
|---|---|
| Instance | `createAuth(env, db)` built per request in a Hono middleware next to the existing `c.var.db` (D1 bindings exist only per request). `drizzleAdapter(db, { provider: "sqlite", schema })` |
| Mount | `app.all("/api/auth/*", c => c.var.auth.handler(c.req.raw))` in `worker/src/app.ts`, registered before the SPA/slug catch-all |
| `user` model | `modelName: "users"`; fields `name -> full_name`, `createdAt -> created_at`, `updatedAt -> updated_at`, `emailVerified -> email_verified` (new), `image -> image` (new). Ids keep the UUID convention: `advanced.database.generateId` returns `crypto.randomUUID()` (check the option name in the pinned version). The drizzle adapter accepts text date columns (Better Auth drizzle docs, "Date Columns") |
| New tables | `session`, `account`, `verification`, `invitation`, written as the CLI generates them (integer `timestamp_ms` dates), in `worker/migrations/0006_better_auth.sql`. Additive only |
| `organization` model | `modelName: "organizations"`; fields name, slug, `logo` (new), `metadata` (new), createdAt. `clerk_org_id` gets a drizzle `$defaultFn` (section 3 item 9) |
| `member` model | `modelName: "organization_memberships"`; organizationId, userId, role, createdAt. `leader_user_id`, `status`, `revoked_at`, `clerk_membership_id` stay as they are with their defaults |
| Roles | Role strings stay `admin`, `leader`, `member`, `viewer`, so `permissions.ts` keeps working untouched. The org plugin gets `ac` with Better Auth's default statement (organization, member, invitation). `admin` gets organization:update, member:create/update/delete, invitation:create/cancel. `leader`, `member` and `viewer` get none of those. `creatorRole: "admin"` (no `owner` role). `permissions.ts` remains the only authority for ChampBeam features; the Better Auth roles only gate Better Auth's own org-management endpoints |
| Org creation | `allowUserToCreateOrganization: false`. Orgs are created by the import or by Deep. This matches the Clerk `create_organization_enabled=false` lock in `clerk_bulk_membership.mjs` |
| Revocation | Revoke means Better Auth `removeMember`, which deletes the row. No token sync remains that could revive it, so tombstones are no longer needed. `resolveActiveMembership` keeps its `status='active'` filter as defence |
| Sessions | Stored in the D1 `session` table. `expiresIn` 7 days and `updateAge` 1 day (parity with Clerk Hobby's fixed 7-day session). `cookieCache` **off**, so a revoked session or membership dies on the next request. `cookiePrefix: "champbeam"`; HttpOnly, Secure and SameSite=Lax (Better Auth defaults, asserted in a test). `trustedOrigins` comes from the existing `CORS_ALLOW_ORIGINS` list |
| Secrets/vars | New secret `BETTER_AUTH_SECRET` (32+ random bytes, set per Worker by the cutover operator, never in chat). New var `BETTER_AUTH_URL` per env. `STORAGE_UPLOAD_SECRET` becomes required; `env.ts` throws at boot when it is missing, and the `accessControl.ts:119` literal fallback is removed |
| Worker verification | `security.ts resolveIdentity`: drop `verifyClerkToken` and `resolveUser`; call `auth.api.getSession({ headers: c.req.raw.headers })`. Then `TokenData.userId = session.user.id`, and the org is resolved from `session.session.activeOrganizationId` through the existing membership check by **local org id**. `TokenData.orgId` becomes `organizations.id` (UUID); update the 5 call sites in section 1. `requireClerkAuth` is renamed `requireSessionAuth`, keeps rejecting API keys, and takes a session cookie instead of a bearer |
| Unchanged | `cb_live_` API keys (`security.ts` resolveApiKey), `X-Service-Key` (`serviceAuth.ts`; only line 105 changes, to return `organizations.id`), `permissions.ts`, rate-limit helpers |
| Retired after rollback window | `services/clerk.ts`, `routes/webhooks.ts` `/clerk`, `jose` JWKS code, `CLERK_*` settings, `scripts/clerk_bulk_membership.mjs`. They stay inert (no secrets) until section 7 step 9 |
| R6 CSRF | Middleware: when a request on `/api/v1` is authenticated by cookie and the method is not GET/HEAD/OPTIONS, require `Origin` to be in `trustedOrigins`, else 403 `{"detail":"Cross-site request blocked"}`. API-key and service-key requests are exempt |
| Brute force | Better Auth `rateLimit: { enabled: true, storage: "database" }` (per-isolate memory is useless on Workers). Sign-in endpoints get a 5 per 60 s window per IP |
| Sign-in methods | Email and password always. New hashes use Better Auth's default scrypt. `password.verify`: when the hash starts with `$2`, use `bcryptjs.compare`; otherwise Better Auth's default `verifyPassword` from `better-auth/crypto` (check the export name). Google and/or Microsoft (`tenantId: "common"`) only if the triage shows users with `oauth_google` / `oauth_microsoft` (parity, not expansion). `account.accountLinking: { enabled: true, trustedProviders: [the enabled social ids] }` |
| Email | Only if D2 = Resend. Then: `sendResetPassword`, the `magicLink` plugin, and `sendInvitationEmail` through Resend's HTTP API (key `RESEND_API_KEY` as a Worker secret). Otherwise all three stay off, and reset is not self-serve at launch |
| Frontend | `better-auth/react` `createAuthClient({ plugins: [organizationClient()] })`, same origin. Drop `@clerk/react`, the axios bearer interceptor (`api/client.ts:31-42`) and `setTokenGetter`. Section 8 has the file list |

## 5. Every column that holds an identity (keep these working)

Clerk id columns (kept, read-only after cutover, dropped only after the rollback window):

| Column | Where | Use after cutover |
|---|---|---|
| `users.clerk_id` | `schema.ts:30`, unique idx `0001_init.sql:26` | Import join key; provenance |
| `organizations.clerk_org_id` | `schema.ts:47`, NOT NULL, unique idx `0001_init.sql:36` | Provenance; placeholder UUID for new orgs |
| `organization_memberships.clerk_membership_id` | `schema.ts:63`, idx `0001_init.sql:52` | Provenance only |

Columns referencing `users.id`. Ids are preserved, so none of them changes. Any merge of two
users rows must rewrite all of them:

| # | Column | schema.ts | On delete |
|---|---|---|---|
| 1 | organization_memberships.user_id | 59 | cascade |
| 2 | organization_memberships.leader_user_id | 64 | set null |
| 3 | reporting_grants.user_id | 80 | cascade |
| 4 | reporting_grants.leader_user_id | 85 | cascade |
| 5 | reporting_grants.granted_by_user_id | 86 | set null |
| 6 | api_keys.user_id | 105 | cascade |
| 7 | utm_presets.user_id | 124 | cascade |
| 8 | projects.user_id | 142 | cascade |
| 9 | domains.user_id | 158 | cascade |
| 10 | link_clicks.user_id (links) | 184 | cascade |
| 11 | file_assets.user_id | 231 | cascade |
| 12 | link_tags.user_id | 307 | cascade |
| 13 | content_items.created_by_user_id | 340 | set null |
| 14 | content_shares.shared_by_user_id | 360 | cascade |
| 15 | assignments.assigned_to_user_id | 376 | cascade |
| 16 | assignments.assigned_by_user_id | 379 | set null |
| 17 | champvault_favorites.user_id | 386 | cascade |
| 18 | rooms.owner_user_id | 415 | set null |
| 19 | room_recipients.owner_user_id | 439 | set null |

Org references (`organization_id` on 10 tables, `schema.ts:56,77,178,211,256,337,357,371,412,436`)
point at `organizations.id` and do not change. Click events attach to links, not users.

## 6. Account migration

Inputs (all three are needed):
1. The Clerk **production** dashboard CSV export (Settings, User exports). Deep downloads it.
   It holds password hashes, so it is secret material: save it to `~/.hermes/secrets/clerk-prod-users-YYYYMMDD.csv`
   with mode 600. Never in a repo, the vault, a card or chat. Delete it after the prod import.
2. The Backend API `GET /v1/users` (external_accounts, last_sign_in_at) and org memberships, read only.
3. The triage table Deep approved (C1): for each Clerk user, a decision of keep, personal or drop,
   plus target org and role.

Script `worker/scripts/import_clerk_to_better_auth.mjs` runs as a dry run unless `--apply`, and is
idempotent. It runs **after** the Postgres to D1 load on that environment. Per approved user:
1. Find the `users` row by `clerk_id`. If there is none, find it by a non-placeholder email. If there
   is still none, create a new row (UUID). Set the email from Clerk's primary email, `email_verified`
   from Clerk, and `full_name` only when it is null. Set `clerk_id` when it is missing.
2. If the email already belongs to a different row: write it to the report as `DUPLICATE` and skip the user.
3. `account` rows: `credential` with `password = password_digest` when `password_hasher` is bcrypt
   (any other hasher is reported and not imported). One row per Google/Microsoft external account,
   with `accountId = provider_user_id`.
4. Orgs: make sure `Champions Group` (slug `champions-group`) and `LakeB2B` (slug `lakeb2b`) exist, and
   reuse a Clerk-mirrored org row when one exists. Members get the role from the table. `personal` gets no membership.
5. `drop`: no `account` row, and `is_active = 0` if the row exists. Nothing is deleted.
6. Output: counts as JSON (`approved, matched_by_clerk_id, matched_by_email, created, duplicate,
   credential_imported, oauth_linked, no_credential, dropped, members_added`) and a per-user report
   at `~/.hermes/secrets/import-report-<env>.csv` (no hashes in it).

Users with no importable credential (email-code-only, or a non-bcrypt hasher) can sign in through a
magic link or reset only if D2 = Resend. Otherwise they are listed for Deep. Everyone signs in once
after cutover, because Clerk sessions do not carry over.

## 7. Cutover and rollback

Ordering, as card dependencies:
`t_5a04f003 (PR #52 audit) -> C3 backend -> C4 frontend -> C6 auth audit -> C7 cutover`;
`C1 triage (Deep approves) -> C5 import -> C6`; `C2 decisions -> C3, C5`.
The auth rewrite branches from the **audited** PR #52 head, so it never lands under the first audit's stamp.

C7 steps. Each production step needs Deep's explicit "go" comment on C7.
1. Confirm the account is on Workers Paid. Take a D1 Time Travel bookmark of the target DB
   (`wrangler d1 time-travel info <db>`) and record the current Worker version id.
2. Staging: apply 0006, set `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` and `STORAGE_UPLOAD_SECRET`
   (plus OAuth/Resend secrets if approved), then deploy `feat/better-auth`.
3. Staging import from a **Clerk development instance** export: dry run, then `--apply`.
4. Staging smoke, with every item recorded on C7: password sign-in, Google sign-in if enabled, org
   switch, a non-member denied (403), a cross-site POST denied (R6), an API key call still 200,
   and a service key call still 200.
5. Production gate: the Postgres to D1 load (runbook P7/P8) is done, and the prod `users` count matches Postgres.
6. Production: apply 0006, set secrets, import dry run, then Deep reviews the counts and comments "go".
7. Import `--apply`, then deploy.
8. Production smoke as in step 4, plus: for 3 named approved users, owned link and file counts
   equal the Postgres counts.
9. 30 days later, if no rollback happened: a follow-up card removes the Clerk code, settings and
   columns. Not created now.

Rollback triggers, any one of: an approved password user in the smoke set cannot sign in; an owned
count mismatch for any checked user; `/api/auth` 5xx above 1% over 30 minutes; any R6 bypass found.
Rollback: `wrangler rollback <previous version id>`. Migration 0006 is additive, so the old build
runs on the same DB. If the import corrupted rows, restore D1 to the step 1 bookmark. The Clerk
instance is left untouched for 30 days. Honest limit: until Clerk keys are set, the previous build
also cannot sign anyone in. Rolling back restores today's state, not working Clerk auth.

## 8. Frontend scope (C4)

Files on `@clerk/react` today: `main.tsx` (ClerkProvider), `App.tsx` (Show, SignIn, SignUp,
useAuth; routes `/sign-in/*`, `/sign-up`), `components/AccountFooter.tsx` (useClerk, useUser,
OrganizationSwitcher), `components/layout/Sidebar.tsx` (UserButton, useAuth),
`components/layout/Navigation.tsx` (Show, SignInButton, SignUpButton, UserButton,
OrganizationSwitcher), `components/AssistantDrawer.tsx:100` (thread key from userId/orgId),
`components/SessionScope.tsx` (getToken, cache key), `hooks/useOrgContext.ts`,
`pages/SettingsPage.tsx`, `pages/HomePage.tsx`, `api/client.ts`, `api/files.ts`, and tests
`AccountReporting.test.tsx`, `ShareComposer.test.tsx`, e2e `authed.spec.ts`, `app-smoke.spec.ts`.

Component table. House components win, as DESIGN.md section 4 says ("Reuse house inputs,
buttons"). The 21st.dev MCP was not reachable from the planner session, and the house set covers
every region:

| Region | Component | Role | Visual contract |
|---|---|---|---|
| Sign-in page `/sign-in` | house `ui/Card`, `ui/Input`, `ui/Button` | Email, password, submit; Google/Microsoft buttons only if enabled; "Forgot password" only if D2 = Resend | Labelled inputs, 44 px targets, inline error under the field, busy state on submit |
| Sign-up page `/sign-up` | same | Name, email, password | same |
| Reset / magic-link pages | same | Only if D2 = Resend | same |
| Org switcher (Navigation, AccountFooter) | house `ui/dropdown-menu` | Lists `authClient.useListOrganizations()` plus "Personal"; sets the active org; clears the query cache | Active org shows a check; the personal entry always comes first |
| Account menu (Sidebar) | house `ui/dropdown-menu` | Name, email, sign out | |

## 9. Decisions for Deep (on card C2)

- D1 path. **A (rec)**: Better Auth as above, no Clerk spend. B: Clerk free, 3 orgs with 20 members
  or fewer each, $0, fastest (keys only). C: Clerk plus the Enhanced B2B add-on, $85/mo annual or
  $100/mo. Not offered: Pro at $20, because it does not lift the cap.
- D2 email sender. **A (rec)**: Resend free (3,000 emails a month, 100 a day). This needs DNS records
  on a sending subdomain and a key saved to `~/.hermes/secrets/resend.key`. B: no email at launch;
  email-code-only users cannot sign in until it is added.
- D3 bridge. **A (rec)**: set Clerk free keys now only if people need Cloudflare sign-in before
  Better Auth ships. B: no bridge.
- D4 OAuth apps, only if the triage shows Google/Microsoft users: someone with access creates a
  Google OAuth client and/or a Microsoft Entra app with redirect `https://<app host>/api/auth/callback/<google|microsoft>`
  and saves the client id and secret under `~/.hermes/secrets/`.

## 10. Cost

| Option | Licence per year | Notes |
|---|---|---|
| Clerk Hobby (free) | $0 | 20 members per org, 100 retained orgs, fixed 7-day session |
| Clerk Pro | $240 (annual) or $300 (monthly) | Same 20-member cap. Adds branding removal, MFA, custom session length |
| Clerk + Enhanced B2B | $1,020 (annual) or $1,200 (monthly) | Unlimited members per org |
| **Better Auth** | **$0** (MIT) | Runs on Workers Paid ($5/mo per account, likely already paid; verify) and D1. About 40 users and one D1 session read per request sit far inside the included 10M requests and 30M CPU ms. Resend free is $0 |

Avoided: $240 to $1,200 a year. Paid instead: the C3 to C6 engineering, plus ongoing ownership of auth
security (rate limits, CSRF, secrets, upgrades) that Clerk carried before.

## 11. What was verified vs open

Verified: D1 counts, the column inventory, auth code paths, Clerk pricing and export docs, Better
Auth docs for the Hono mount, getSession, org schema mapping, the ac/roles, a bcrypt verify hook,
text date columns, the Microsoft tenantId and magic link.
Open: the account's Workers plan; Clerk prod sign-in methods and user list (C1); whether the drizzle
adapter applies `$defaultFn` (C3 test); exact option and export names in the pinned Better Auth
version (C3); where legacy hosted HTML is served (C6).
