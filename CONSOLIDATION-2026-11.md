# ChampBeam V2 consolidation, November 2026

**Branch:** `v2/consolidated-2026-11` off `origin/main` 0ef93a5 (PR #71, live on champbeam.com). **Draft PR #76. Nothing is merged, closed, deleted or deployed.**
**Code head:** `4801c294161b637850d44f6c4c5ef2f3598a18f3` (a docs-only commit with this report sits on top of it). The fresh-clone runs in section 5 were taken at the earlier code head `90429ce`; the only change since is the em-dash glue commit 4801c29 (four string literals in the Intranet files), and the provider CI result on the new heads is in section 5.

## 1. Decision for Deep

V2 carries 12 of the 14 open PRs (#60, #61, #62, #63, #64, #66, #67, #68, #69, #70, #73, #74). The other two are superseded: #72 by the landing v2 you approved on 20 Nov, #75 by a fix already inside #66. V2 also carries the approved refresh release candidate, the Intranet and two small unmerged script and doc branches. Everything that could be tested was tested from a fresh clone of the pushed branch (section 5). Every CI job is green except `Workers Builds: champbeam`, which is also red on merged PR #71 and on every other open PR (pre-existing, section 6).

- **A (recommended):** merge draft PR #76 (squash, so the QA screenshots PR #62 committed stay out of `main` history), then close PRs #60, #61, #62, #63, #64, #66, #67, #68, #69, #70, #72, #73, #74, #75 with a comment pointing at #76, and delete the 37 origin branches listed in section 7. Production deploy stays a separate gated step (section 8), and stays so only while the Workers Builds dashboard values are left unchanged: setting them is the deploy trigger.
- **B:** merge only, keep every branch and PR.
- **C:** hold.

## 2. State at intake

`origin/main` = 0ef93a5. 14 open PRs, 37 other branches on origin, 42 refs on the `champ-backup` remote, and 11 local branches holding commits that existed on no remote (including the approved release candidate `rel/refresh-landing-v2`, the audit run-5 security fixes and the landing v2 work). A prior consolidation (t_51e5e84d, PR #42, then #53) is already on main, so only newer work was classified.

## 3. What V2 contains

84 commits on main, 280 files (this report included). Merged in this order (dependency first; the order follows the reconciliation on t_43f209c8):

1. PR #70, PR #69 (build config and docs)
2. `rel/refresh-landing-v2` (68b9184): refresh, globe, landing v2, auto-join `championsmail.com,lakeb2b.com`
3. PR #60, then #67 (stacked), then #74 (migration 0010)
4. PR #64 (through its rebased copy), then #66 (stacked)
5. PR #61, PR #63, PR #68, PR #62, PR #73
6. `feat/clerk-password-import`, `docs/agents-a1-a2-prd`
7. `feat/intranet-cloudflare` last. It is NOT cleanly separable: its migration `0009_intranet.sql` and the shared `schema.ts` columns couple it to the ChampBeam Worker (section 6, resolution 29)

Plus V2-only commits: the PR #62 QA evidence files removed from the tree, the CI worker job now also runs the Intranet vitest config, the em dashes in the carried Intranet strings replaced (the no-dash rule; `git diff -U0 origin/main HEAD` added lines count 0 of U+2014 and U+2013), and this report.

## 4. Verdict table, every branch and PR

Verdicts: CONTAINED (ancestor, proven with `git merge-base --is-ancestor`), UNIQUE WORK carried, SUPERSEDED (replacement named), HELD or EVIDENCE (not carried, reason given). No branch has a different root commit: all 131 refs examined (origin, champ-backup and local) share root commit 37b383c, so none is "not this project".

### 1. Remote branches on origin (39 refs: the 37 branches below, `main` and V2 itself)

| Branch | Tip | PR | Verdict | Why | Proof command (exit 0 = yes) |
|---|---|---|---|---|---|
| `origin/claude/friendly-turing-tiwr9b` | 9f94867 2026-06-25 | merged earlier | **CONTAINED in main** | 0 commits ahead of origin/main | `git merge-base --is-ancestor origin/claude/friendly-turing-tiwr9b origin/main` |
| `origin/claude/gracious-johnson-a8vcfn` | bb4ee80 2026-07-24 | merged earlier | **CONTAINED in main** | 0 commits ahead of origin/main | `git merge-base --is-ancestor origin/claude/gracious-johnson-a8vcfn origin/main` |
| `origin/cloudflare` | e26f2a4 2026-10-22 | merged earlier | **CONTAINED in main** | 0 commits ahead of origin/main | `git merge-base --is-ancestor origin/cloudflare origin/main` |
| `origin/cursor/docs-match-production-c178` | 831bc17 2026-11-12 | PR #69 | **UNIQUE WORK carried** | 831bc17 README and deploy docs match the Worker on champbeam.com. Resolution 1 | `git merge-base --is-ancestor origin/cursor/docs-match-production-c178 v2/consolidated-2026-11` |
| `origin/cursor/restore-signed-out-landing-d053` | 7f8c9ae 2026-11-14 | PR #72 | **SUPERSEDED** | Replaced by landing v2 (d8bde94, 858ac62 in V2; Deep's 20 Nov ruling: close #72 as superseded). Proof: V2 `HomePage.tsx` renders `SignedOutLanding`; `LandingPage.tsx` from #72 does not exist in V2. WARNING: `git merge-tree` of #72 against V2 is textually CLEAN, so merging it would land a second landing beside the first | `git merge-tree --write-tree v2/consolidated-2026-11 origin/cursor/restore-signed-out-landing-d053` |
| `origin/cursor/share-domain-links-77b8` | 28cef5b 2026-11-14 | PR #73 | **UNIQUE WORK carried** | 28cef5b hosted page links resolve (/p/slug, /f/code) until the share domain answers /health | `git merge-base --is-ancestor origin/cursor/share-domain-links-77b8 v2/consolidated-2026-11` |
| `origin/cursor/surface-visitor-ip-1ea0` | 310046e 2026-11-12 | PR #68 | **UNIQUE WORK carried** | 310046e visitor IP and stored company on owner analytics. Resolution 26 | `git merge-base --is-ancestor origin/cursor/surface-visitor-ip-1ea0 v2/consolidated-2026-11` |
| `origin/cursor/workers-builds-config-6ef1` | 74e5863 2026-11-12 | PR #70 | **UNIQUE WORK carried** | 74e5863 pins `npm run deploy` to `--env=""` and records the Workers Builds dashboard values | `git merge-base --is-ancestor origin/cursor/workers-builds-config-6ef1 v2/consolidated-2026-11` |
| `origin/docs/agents-a1-a2-prd` | fec2dc8 2026-11-12 | no PR | **UNIQUE WORK carried** | fec2dc8 PRD for agents A1 and A2 (docs only) | `git merge-base --is-ancestor origin/docs/agents-a1-a2-prd v2/consolidated-2026-11` |
| `origin/docs/ui-brief-v1` | 2fff639 2026-11-11 | merged earlier | **CONTAINED in main** | 0 commits ahead of origin/main | `git merge-base --is-ancestor origin/docs/ui-brief-v1 origin/main` |
| `origin/feat/assistant-worker` | 9f80aaf 2026-11-06 | merged earlier | **CONTAINED in main** | 0 commits ahead of origin/main | `git merge-base --is-ancestor origin/feat/assistant-worker origin/main` |
| `origin/feat/better-auth` | 8292c14 2026-11-06 | merged earlier | **CONTAINED in main** | 0 commits ahead of origin/main | `git merge-base --is-ancestor origin/feat/better-auth origin/main` |
| `origin/feat/better-auth-ui` | cf34de1 2026-11-06 | PR #57 closed | **SUPERSEDED (patch already on main)** | cf34de1 (first-load session latch) has a patch-equivalent commit on main: `git cherry origin/main origin/feat/better-auth-ui` prints `-` | `git cherry origin/main origin/feat/better-auth-ui` |
| `origin/feat/cf-visitor-intel` | b800cbe 2026-10-29 | PR #52 closed | **SUPERSEDED** | its one unique commit b800cbe (axios 1.21.0, react-router 7.18.5, form-data 4.0.6) is on main under the same subject, and main's lockfile resolves exactly those versions | `git show origin/main:frontend/package-lock.json | grep -A1 node_modules/axios` |
| `origin/feat/clerk-password-import` | 21808fe 2026-11-10 | no PR | **UNIQUE WORK carried** | 21808fe script that imports Clerk bcrypt hashes as Better Auth credential rows (dry run by default) | `git merge-base --is-ancestor origin/feat/clerk-password-import v2/consolidated-2026-11` |
| `origin/feat/domain-records` | 4c03f89 2026-11-06 | PR #60 | **UNIQUE WORK carried** | b11b0ca, bb79ae4, 4c03f89: TXT pre-validation records, records.txt, org-domain adoption, SaaS setup script. Resolution 2 | `git merge-base --is-ancestor origin/feat/domain-records v2/consolidated-2026-11` |
| `origin/feat/domain-records-ui` | 8a97d9d 2026-11-12 | PR #67 | **UNIQUE WORK carried** | fb740ed, 8a97d9d plus PR #60's three. Resolutions 3, 4 | `git merge-base --is-ancestor origin/feat/domain-records-ui v2/consolidated-2026-11` |
| `origin/feat/forgot-password` | 1d0a21d 2026-11-12 | merged earlier | **CONTAINED in main** | 0 commits ahead of origin/main | `git merge-base --is-ancestor origin/feat/forgot-password origin/main` |
| `origin/feat/intranet-cloudflare` | 51216ff 2026-11-13 | no PR | **UNIQUE WORK carried** | 14 commits: Intranet P0 to P2 on the Worker, own env, D1 and R2. Resolution 29 | `git merge-base --is-ancestor origin/feat/intranet-cloudflare v2/consolidated-2026-11` |
| `origin/feat/intranet-p0` | 63c277a 2026-11-06 | no PR | **CONTAINED in V2** | ancestor of feat/intranet-cloudflare, which is carried | `git merge-base --is-ancestor origin/feat/intranet-p0 v2/consolidated-2026-11` |
| `origin/feat/intranet-p1` | 0eac7e8 2026-11-06 | no PR | **CONTAINED in V2** | ancestor of feat/intranet-cloudflare, which is carried | `git merge-base --is-ancestor origin/feat/intranet-p1 v2/consolidated-2026-11` |
| `origin/feat/intranet-p2` | 5e23c5f 2026-11-06 | no PR | **CONTAINED in V2** | ancestor of feat/intranet-cloudflare, which is carried | `git merge-base --is-ancestor origin/feat/intranet-p2 v2/consolidated-2026-11` |
| `origin/feat/link-attribution-slice1` | b8a0873 2026-11-06 | PR #63 (draft) | **UNIQUE WORK carried** | b8a0873 cb_id passthrough, channel, visitor type, scanner flag (migration 0004_attribution_slice1). Resolutions 24, 25 | `git merge-base --is-ancestor origin/feat/link-attribution-slice1 v2/consolidated-2026-11` |
| `origin/feat/org-email-domains` | 223483f 2026-11-06 | PR #61 | **UNIQUE WORK carried** | eabbdc4, 223483f: admin-managed email-domain auto-join. Merged additively to the env allowlist. Resolutions 21 to 23 | `git merge-base --is-ancestor origin/feat/org-email-domains v2/consolidated-2026-11` |
| `origin/feat/railway-redirect-to-cloudflare` | c826d7b 2026-11-06 | merged earlier | **CONTAINED in main** | 0 commits ahead of origin/main | `git merge-base --is-ancestor origin/feat/railway-redirect-to-cloudflare origin/main` |
| `origin/feat/self-serve-orgs` | 5db1b69 2026-11-07 | PR #64 | **UNIQUE WORK carried** | 0ed0ef6, 31c3608, d53fa4c, ec4f603, 5db1b69 (personal sign-up, invites, roles, super admin, legacy host). Carried through its rebased copy and again through PR #66, so its head is an ancestor of V2. Resolutions 7 to 10 | `git merge-base --is-ancestor origin/feat/self-serve-orgs v2/consolidated-2026-11` |
| `origin/feat/self-serve-orgs-ui` | 0a557d6 2026-11-13 | PR #66 | **UNIQUE WORK carried** | 4a993ae, 44e6084, 350875b, 1808052, 0a557d6 plus PR #64's five. Resolutions 11 to 20 | `git merge-base --is-ancestor origin/feat/self-serve-orgs-ui v2/consolidated-2026-11` |
| `origin/feat/ui-redo-21st` | ad3c34c 2026-11-13 | merged earlier | **CONTAINED in main** | 0 commits ahead of origin/main | `git merge-base --is-ancestor origin/feat/ui-redo-21st origin/main` |
| `origin/feat/visitor-journeys-api` | 2782706 2026-11-05 | merged earlier | **CONTAINED in main** | 0 commits ahead of origin/main | `git merge-base --is-ancestor origin/feat/visitor-journeys-api origin/main` |
| `origin/feat/visitor-journeys-ui` | 1e81cd0 2026-11-06 | PR #62 | **UNIQUE WORK carried** | 2bda4e2, 174d9bb, 13ed7c0, ea38da3, 1e81cd0 (journeys on dotted world maps). Resolutions 27, 30 | `git merge-base --is-ancestor origin/feat/visitor-journeys-ui v2/consolidated-2026-11` |
| `origin/fix/deflake-versions-rollback-test` | 27fb340 2026-11-20 | PR #75 | **SUPERSEDED** | The same flaky assertion (`test_versions_rollback_and_prune`) is fixed in V2 by PR #66's commit 1808052 (`document_body` plus a fixed visitor cookie). Merging #75 conflicts on exactly those lines. Resolution 28 | `git merge-base --is-ancestor 1808052 v2/consolidated-2026-11` |
| `origin/rebase/pr64-on-0ef93a5` | 0aeb7b8 2026-11-07 | rebase of PR #64 | **UNIQUE WORK carried (duplicate of PR #64)** | same five patches as PR #64 on base 0ef93a5; used as the carrier for PR #64. Not a separate piece of work | `git merge-base --is-ancestor origin/rebase/pr64-on-0ef93a5 v2/consolidated-2026-11` |
| `origin/rel/cloudflare-cutover` | ba61409 2026-11-06 | merged earlier | **CONTAINED in main** | 0 commits ahead of origin/main | `git merge-base --is-ancestor origin/rel/cloudflare-cutover origin/main` |
| `origin/sec/domain-txt-proof-migration` | 7087234 2026-11-19 | PR #74 (draft) | **UNIQUE WORK carried** | 7087234 `0010_domain_claim_token.sql`: `verification_token` and active-only unique hostname index. Resolution 5. The Worker half (card t_43be35ca) has no code yet, see "not done" | `git merge-base --is-ancestor origin/sec/domain-txt-proof-migration v2/consolidated-2026-11` |
| `origin/t_56fb02bb/staging-proof` | fb04f89 2026-11-12 | merged earlier | **CONTAINED in main** | 0 commits ahead of origin/main | `git merge-base --is-ancestor origin/t_56fb02bb/staging-proof origin/main` |
| `origin/v2-consolidation` | 6895a69 2026-10-20 | merged earlier | **CONTAINED in main** | 0 commits ahead of origin/main | `git merge-base --is-ancestor origin/v2-consolidation origin/main` |
| `origin/v3/cloudflare-release` | 92d7de6 2026-10-25 | merged earlier | **CONTAINED in main** | 0 commits ahead of origin/main | `git merge-base --is-ancestor origin/v3/cloudflare-release origin/main` |

### 2. Local branches that exist only on this Mac (not on any remote)

Found at intake with `git rev-list --count <branch> --not --remotes=origin` (counted here against every origin ref except the V2 branch pushed by this card). These held commits that were never pushed; V2 now publishes the ones it carries.

| Branch | Tip | Unpushed commits | Verdict | Why |
|---|---|---|---|---|
| `backup/2026-11-11/wip` | 095ecbc 2026-11-11 | 1 | **EVIDENCE, not carried** | Auto snapshot of the dirty shared checkout (download-disposition work for the legacy FastAPI backend). Main already ships the later versions of the same six files |
| `backup/2026-11-11/wip-wt` | 9283c78 2026-11-11 | 1 | **EVIDENCE, not carried** | Snapshot of a worktree: 190 files including .verify screenshots. Public repo, no QA artifacts in commits |
| `backup/2026-11-12/wip` | 7cb6e76 2026-11-12 | 1 | **EVIDENCE, not carried** | Same snapshot, one day later |
| `docs/t_5a608473-better-auth-prd` | 0e59d8d 2026-11-05 | 1 | **SUPERSEDED** | 0e59d8d adds docs/BETTER-AUTH-PRD.md, which exists on main (3 lines differ); b800cbe is on main |
| `feat/landing-v2` | cf3d723 2026-11-20 | 14 | **CONTAINED in V2, one commit dropped on purpose** | Four of its five unique commits are patch-equivalent to V2's rebased copies (`git cherry` prints `-`). The fifth, 78aacf4 (UI brief doc, "local only, drop before any PR"), is deliberately not carried |
| `feat/one-composer-design` | ddec72e 2026-10-24 | 1 | **SUPERSEDED** | ddec72e DESIGN.md and PRODUCT.md exist on main in later versions from the UI redo (#71). NOTES.md (14 lines) is not on main: not carried |
| `fix/account-loading-recovery-20261113` | eb8c117 2026-11-14 | 7 | **CONTAINED in V2 (via rel/refresh-landing-v2)** | Holds the audit run-5 security fixes and the refresh (6cdad73 .. eb8c117). Ancestor of V2 |
| `preview/refresh-globe` | 78aacf4 2026-11-19 | 10 | **CONTAINED in V2, one commit dropped on purpose** | Only 78aacf4 (the same UI brief doc) is not in V2 |
| `rel/refresh-landing-v2` | 68b9184 2026-11-20 | 14 | **UNIQUE WORK carried** | The release candidate Deep approved on 20 Nov (refresh eb8c117 + globe + landing v2 + auto-join lakeb2b.com). Merged whole; its tip 68b9184 is an ancestor of V2 |
| `sec/domain-txt-proof-ui` | af109e0 2026-11-19 | 1 | **HELD, not carried** | af109e0 TXT ownership proof in Settings. Rewrites SetupInstructions, which PR #67 rewrote completely, and its API (`txt_name`, `txt_value`) has no producer yet. Resolution 6 |
| `sec/t_5a04f003-audit` | 5ecb39c 2026-11-05 | 9 | **SUPERSEDED** | All ten commits have a same-subject copy on main (audit runs 1 to 3 and the dep bump, rebased as `sec/t_5a04f003-main`, ancestor of main) |

The other 39 local branches have 0 commits outside origin (`git rev-list --count <b> --not --remotes=origin` prints 0), so they are mirrors and need no verdict of their own.

### 3. Backup remote `champ-backup` (ChampBeam-backup, evidence only, never a target)

| Ref | Tip | Verdict | Why |
|---|---|---|---|
| `champ-backup` | 5e26adc 2026-09-07 | **CONTAINED in main** | `git merge-base --is-ancestor champ-backup origin/main` |
| `champ-backup/avail/t_0a517950` | e0a472f 2026-10-24 | **CONTAINED in main** | `git merge-base --is-ancestor champ-backup/avail/t_0a517950 origin/main` |
| `champ-backup/backup/2026-11-11/wip` | 095ecbc 2026-11-11 | **EVIDENCE** | dirty-checkout snapshot, see section 2 |
| `champ-backup/backup/2026-11-11/wip-wt` | 9283c78 2026-11-11 | **EVIDENCE** | worktree snapshot with QA screenshots, see section 2 |
| `champ-backup/backup/2026-11-12/wip` | 7cb6e76 2026-11-12 | **EVIDENCE** | dirty-checkout snapshot, see section 2 |
| `champ-backup/docs/t_5a608473-better-auth-prd` | 0e59d8d 2026-11-05 | **SUPERSEDED** | docs/BETTER-AUTH-PRD.md is on main |
| `champ-backup/docs/ui-brief-v1` | 2fff639 2026-11-11 | **CONTAINED in main** | `git merge-base --is-ancestor champ-backup/docs/ui-brief-v1 origin/main` |
| `champ-backup/feat/assistant-worker` | 9f80aaf 2026-11-06 | **CONTAINED in main** | `git merge-base --is-ancestor champ-backup/feat/assistant-worker origin/main` |
| `champ-backup/feat/better-auth` | 8e5e8c6 2026-11-06 | **CONTAINED in main** | `git merge-base --is-ancestor champ-backup/feat/better-auth origin/main` |
| `champ-backup/feat/better-auth-ui` | cf34de1 2026-11-06 | **SUPERSEDED** | cf34de1 is patch-equivalent on main |
| `champ-backup/feat/cf-visitor-intel` | 8385681 2026-11-02 | **CONTAINED in main** | `git merge-base --is-ancestor champ-backup/feat/cf-visitor-intel origin/main` |
| `champ-backup/feat/clerk-password-import` | 21808fe 2026-11-10 | **CONTAINED in V2** | carried from origin (21808fe) |
| `champ-backup/feat/domain-records` | 4c03f89 2026-11-06 | **CONTAINED in V2** | carried (PR #60) |
| `champ-backup/feat/domain-records-ui` | fb740ed 2026-11-06 | **CONTAINED in V2** | ancestor of V2 |
| `champ-backup/feat/file-download-mode` | 37e2ac6 2026-10-17 | **CONTAINED in main** | `git merge-base --is-ancestor champ-backup/feat/file-download-mode origin/main` |
| `champ-backup/feat/forgot-password` | 62b760b 2026-11-11 | **CONTAINED in main** | `git merge-base --is-ancestor champ-backup/feat/forgot-password origin/main` |
| `champ-backup/feat/lakeb2b-favicon` | f5bf1ea 2026-10-26 | **CONTAINED in main** | `git merge-base --is-ancestor champ-backup/feat/lakeb2b-favicon origin/main` |
| `champ-backup/feat/lakeb2b-org-migration` | 5b2c0e7 2026-10-26 | **CONTAINED in main** | `git merge-base --is-ancestor champ-backup/feat/lakeb2b-org-migration origin/main` |
| `champ-backup/feat/link-attribution-slice1` | b8a0873 2026-11-06 | **CONTAINED in V2** | carried (PR #63) |
| `champ-backup/feat/migration-banner` | 025f89a 2026-10-26 | **CONTAINED in main** | `git merge-base --is-ancestor champ-backup/feat/migration-banner origin/main` |
| `champ-backup/feat/one-composer-design` | ddec72e 2026-10-24 | **SUPERSEDED** | DESIGN.md and PRODUCT.md are on main in later versions |
| `champ-backup/feat/one-composer-ui` | 9d02fbf 2026-10-24 | **CONTAINED in main** | `git merge-base --is-ancestor champ-backup/feat/one-composer-ui origin/main` |
| `champ-backup/feat/org-email-domains` | 223483f 2026-11-06 | **CONTAINED in V2** | carried (PR #61) |
| `champ-backup/feat/railway-redirect-to-cloudflare` | c826d7b 2026-11-06 | **CONTAINED in main** | `git merge-base --is-ancestor champ-backup/feat/railway-redirect-to-cloudflare origin/main` |
| `champ-backup/feat/visitor-journeys-api` | 2782706 2026-11-05 | **CONTAINED in main** | `git merge-base --is-ancestor champ-backup/feat/visitor-journeys-api origin/main` |
| `champ-backup/feat/visitor-journeys-ui` | 1e81cd0 2026-11-06 | **CONTAINED in V2** | carried (PR #62) |
| `champ-backup/feat/voice-link-opens` | e371101 2026-10-25 | **CONTAINED in main** | `git merge-base --is-ancestor champ-backup/feat/voice-link-opens origin/main` |
| `champ-backup/fix/default-favicon` | 99ba432 2026-10-26 | **CONTAINED in main** | `git merge-base --is-ancestor champ-backup/fix/default-favicon origin/main` |
| `champ-backup/fix/pr42-review-findings` | 36b9edb 2026-10-28 | **CONTAINED in main** | `git merge-base --is-ancestor champ-backup/fix/pr42-review-findings origin/main` |
| `champ-backup/fix/t_1cc6f29b-d1-slug-deleted` | e8a73be 2026-10-26 | **CONTAINED in main** | `git merge-base --is-ancestor champ-backup/fix/t_1cc6f29b-d1-slug-deleted origin/main` |
| `champ-backup/fix/t_7a001972-dep-cves` | b800cbe 2026-10-29 | **SUPERSEDED** | b800cbe is on main under the same subject |
| `champ-backup/fix/t_fa5b7d61` | 058ba6b 2026-10-24 | **CONTAINED in main** | `git merge-base --is-ancestor champ-backup/fix/t_fa5b7d61 origin/main` |
| `champ-backup/main` | 5e26adc 2026-09-07 | **CONTAINED in main** | `git merge-base --is-ancestor champ-backup/main origin/main` |
| `champ-backup/ops/cf-env-overlays` | 28d08d9 2026-10-24 | **CONTAINED in main** | `git merge-base --is-ancestor champ-backup/ops/cf-env-overlays origin/main` |
| `champ-backup/rc/t_4ce44bcb` | 92d7de6 2026-10-25 | **CONTAINED in main** | `git merge-base --is-ancestor champ-backup/rc/t_4ce44bcb origin/main` |
| `champ-backup/rel/cloudflare-cutover` | ba61409 2026-11-06 | **CONTAINED in main** | `git merge-base --is-ancestor champ-backup/rel/cloudflare-cutover origin/main` |
| `champ-backup/sec/t_5a04f003-audit` | 5ecb39c 2026-11-05 | **SUPERSEDED** | same as local sec/t_5a04f003-audit: every commit has a same-subject copy on main |
| `champ-backup/sec/t_5a04f003-main` | 3ce4b58 2026-11-06 | **CONTAINED in main** | `git merge-base --is-ancestor champ-backup/sec/t_5a04f003-main origin/main` |
| `champ-backup/security/gate-backlog-2026-10-29` | e3bb67c 2026-10-29 | **CONTAINED in main** | `git merge-base --is-ancestor champ-backup/security/gate-backlog-2026-10-29 origin/main` |
| `champ-backup/t_56fb02bb/staging-proof` | 9432935 2026-11-11 | **CONTAINED in main** | `git merge-base --is-ancestor champ-backup/t_56fb02bb/staging-proof origin/main` |
| `champ-backup/v2-consolidation` | 37e2ac6 2026-10-17 | **CONTAINED in main** | `git merge-base --is-ancestor champ-backup/v2-consolidation origin/main` |
| `champ-backup/v3/cloudflare-release` | 7ea2e0a 2026-10-24 | **CONTAINED in main** | `git merge-base --is-ancestor champ-backup/v3/cloudflare-release origin/main` |

## 5. Verification (fresh clone of the pushed branch at 90429ce, `git clone --branch v2/consolidated-2026-11`)

| Step | Command | Result |
|---|---|---|
| Frontend install, typecheck | `npm ci` then `npx tsc -b` (Node 20.20.2, as CI) | exit 0, exit 0 |
| Frontend lint | `npm run lint -- --max-warnings=200` | 0 errors, 53 warnings (origin/main measured the same way: 54) |
| Frontend tests | `npm run test` | 34 files, 193 passed (origin/main: 16 files, 105 passed) |
| Frontend build | `VITE_API_URL=https://example.invalid npm run build` | exit 0; the built bundle contains "Create organization", "DNS records for IT", "Forwarded journeys", "Members and teams" |
| Worker install, typecheck | `npm ci` then `npx tsc --noEmit` (Node 22.23.3, as CI) | exit 0, exit 0 |
| Worker env overlays | `node scripts/check-env-overlays.mjs` | OK |
| Worker tests | `npx vitest run` | 57 files, 613 passed (origin/main: 48 files, 528 passed) |
| Intranet tests | `npx vitest run -c vitest.intranet.config.ts` | 4 files, 56 passed (not on main) |
| Worker bundle | `npx wrangler deploy --dry-run --env=""` and `--env intranet` after `node scripts/build-intranet-frontend.mjs --no-install` | both bundle, 3596 KiB each; nothing deployed |
| Backend | `alembic heads` then `python -m pytest -q -p no:cacheprovider` (clean venv, Python 3.11) | one head (`033_intranet_p2`), 258 passed (origin/main: 193 passed) |
| Migration chain | the Worker suite builds the schema from all migrations in sort order | passes; `wrangler d1 migrations list` (read-only) shows production still lacks six of them, section 6 and 8 |

GitHub CI on PR #76 at the code head 90429ce (provider runners, read with `gh pr checks 76`): `backend (pytest)` pass 1m0s, `backend image builds` pass 16s, `frontend (tsc, vitest, eslint)` pass 1m46s, `worker (tsc, vitest)` pass 2m21s (now including the Intranet suite), `gate` pass, Vercel and Vercel Preview Comments pass. `Workers Builds: champbeam` fail, see section 6. The docs-only report commit re-runs the same jobs; the result is posted as a PR comment.

Test accounting: every test title on every carried branch was compared with V2. One test lost in the auto-merge was re-added; two were renamed (resolution 32). No test was deleted.

Security checks run: `gitleaks detect --log-opts=origin/main..HEAD` run at the final head scanned 65 commits (gitleaks skips merge commits; the branch has 84 commits above main) and found no leaks. `deploy_gate.py check .` printed `AUDIT-REQUIRED, WARN-ONLY (in gate-config.json warn_only), not blocking`: 20 sensitive files changed since the last audited state (CI workflow, SessionScope, AuthPages, AdminPage, AdminOrgsPage, five migrations). **That is a skipped full Cloudflare security audit, not a passed one.**

## 6. What is red or unproven

- `Workers Builds: champbeam` fails on this PR, on #71 (merged), #72, #73 and #75. PR #70 (carried here) records the cause measured on 12 Nov: the dashboard project runs `npx wrangler preview` from the repo root with an empty build command. The build log was not read (no stored token used). The fix is a dashboard change (table in CLOUDFLARE_DEPLOY.md), not code.
- Full security audit: not run (above).
- Visual QA of the merged screens (Settings groups with DNS records and email domains, Home with onboarding, Analytics with journeys, org switcher, notifications tray) at phone, tablet and desktop: **not run**. Both PR #62 and the refresh rewrite AnalyticsPage, and PR #66 and the refresh both rewrite Settings and Home. Unit tests pass; nobody has looked at them.
- Staging end to end: the self-serve orgs e2e (`worker/scripts/e2e-self-serve.mjs`), the Intranet acceptance run and a real sign-in were not re-run against staging.
- Backend container: the image builds in CI; it was not started (the legacy FastAPI image needs Postgres and is not the production runtime).
- Migrations were not applied to any remote D1. Read-only `npx wrangler d1 migrations list champbeam --remote --env=""` (run 22 Nov): production has not applied SIX: `0004_attribution_slice1`, `0008_domain_dns_records`, `0009_intranet`, `0009_org_email_domains`, `0009_self_serve_orgs`, `0010_domain_claim_token`. Staging (`champbeam-staging`, `--env=staging`) lists five: the same minus `0009_self_serve_orgs`, which it has applied; it also lacks `0009_intranet`.
- **The Intranet is coupled to the ChampBeam Worker through the database.** `0009_intranet.sql` comes from `feat/intranet-cloudflare` and reaches production because the `intranet` wrangler env shares `migrations_dir: "migrations"`. It ALTERs `organization_memberships` (adds `is_reviewer`, `deactivated_at`) and creates `transfers`, `decision_log` (with two triggers), `org_review_settings`, `org_invites` and `agent_benchmarks`. The shared `worker/src/db/schema.ts` (lines 82-83) now declares both new columns, and ordinary ChampBeam code selects whole rows from that table (`worker/src/services/org.ts` lines 81 and 96, `db.select().from(organizationMemberships)`). So the ChampBeam Worker on V2 fails those queries on production D1 until `0009_intranet` is applied, and reverting merge 243ec21 after the production migrations leaves those columns and tables behind.

## 7. If you choose A: exactly what gets closed and deleted

**Close (after merging #76), each with a comment pointing to #76:** #60, #61, #62, #63, #64, #66, #67, #68, #69, #70, #72, #73, #74, #75 (14 PRs; #63 and #74 are drafts).

**Delete these 37 origin branches** (every one is carried, ancestor of main or V2, or superseded, per section 4): `claude/friendly-turing-tiwr9b`, `claude/gracious-johnson-a8vcfn`, `cloudflare`, `cursor/docs-match-production-c178`, `cursor/restore-signed-out-landing-d053`, `cursor/share-domain-links-77b8`, `cursor/surface-visitor-ip-1ea0`, `cursor/workers-builds-config-6ef1`, `docs/agents-a1-a2-prd`, `docs/ui-brief-v1`, `feat/assistant-worker`, `feat/better-auth`, `feat/better-auth-ui`, `feat/cf-visitor-intel`, `feat/clerk-password-import`, `feat/domain-records`, `feat/domain-records-ui`, `feat/forgot-password`, `feat/intranet-cloudflare`, `feat/intranet-p0`, `feat/intranet-p1`, `feat/intranet-p2`, `feat/link-attribution-slice1`, `feat/org-email-domains`, `feat/railway-redirect-to-cloudflare`, `feat/self-serve-orgs`, `feat/self-serve-orgs-ui`, `feat/ui-redo-21st`, `feat/visitor-journeys-api`, `feat/visitor-journeys-ui`, `fix/deflake-versions-rollback-test`, `rebase/pr64-on-0ef93a5`, `rel/cloudflare-cutover`, `sec/domain-txt-proof-migration`, `t_56fb02bb/staging-proof`, `v2-consolidation`, `v3/cloudflare-release`.

**Keep (never deleted by A):** `main`, `v2/consolidated-2026-11` until merged, every `champ-backup` ref, and the eleven intake-time local-only branches, in particular `sec/domain-txt-proof-ui` (HELD), `feat/landing-v2` and `preview/refresh-globe` (hold the dropped UI brief commit 78aacf4) and the three `backup/*/wip` snapshots.

## 8. Deploy order and decisions that stay with Deep

V2 is a code branch. Production deploy is not part of this card. When you want it, in this order: (1) take a restore point of production D1; (2) apply the six unapplied migrations to production D1 (the list in section 6, including `0009_intranet`, which the ChampBeam Worker needs); (3) finish card t_1e60332a (the `share.lakeb2b.com` fallback origin, which PR #60's `*/*` zone route depends on); (4) deploy `npm run deploy` from `worker/`, or (5) set the Workers Builds dashboard values from CLOUDFLARE_DEPLOY.md (PR #70) as the LAST step: from then on every push to `main` runs `npx wrangler deploy --env=""` (CLOUDFLARE_DEPLOY.md lines 90-93), so setting them earlier would deploy V2 on the first merge, before the migrations and the zone prerequisite. Then read back the served assets and sign-in. `STORAGE_UPLOAD_SECRET` is untouched and must stay so.

Open items needing your ruling:

1. **Zone route.** PR #60 adds `"routes": [{"pattern": "*/*", "zone_name": "champbeam.com"}]` to the production config. Deploying attaches a catch-all route on the zone, and the Cloudflare for SaaS fallback origin for `share.lakeb2b.com` is still unset (card t_1e60332a). Do not deploy before that card.
2. **Who auto-joins the shared org** (membership decision): environment allowlist `championsmail.com,lakeb2b.com` (your 20 Nov ruling) plus PR #61's admin-managed list, which starts empty. Both need a verified email. Resolution 21. **Gap you should know about (already true on the release candidate 68b9184, not a merge regression):** the env allowlist joins only in `user.create.after` and only when the address is already verified (`joinsDefaultOrg`, `worker/src/auth/betterAuth.ts` line 190). The session-create hook (line 162) re-runs only PR #61's admin-managed list. So a password sign-up with an env-allowlisted address (for example @lakeb2b.com) that verifies later never auto-joins the shared org, while an address on the admin-managed list does join at its first sign-in after verification. Google sign-in arrives verified and joins at creation.
3. **Your personal address in a public repo.** `SUPER_ADMIN_EMAILS` is now committed in `worker/wrangler.jsonc` for production, staging and deepify (`deep1499@gmail.com`; staging also `e2e-root@staging.champbeam.test`). It came in with PR #64. It is an allowlist entry, not a credential, and super admin still needs a verified email or Google. If you would rather keep it out of git, it moves to a dashboard variable.
4. **Intranet in this repo, and its schema coupling.** Carried as the last merge. It deploys as its own Worker `champbeam-intranet`, and its routes stay gated off in the ChampBeam Worker unless `INTRANET_MODE=true`, but its schema is NOT separable: `0009_intranet.sql` must be applied to production D1 before the ChampBeam Worker on V2 can run (section 6), and the shared `schema.ts` and `organization_memberships` carry its two columns. Reverting merge 243ec21 removes the code but, once the production migrations have run, not the columns and tables. Keeping it here means accepting that coupling; moving it to its own repo should happen BEFORE the production migrations, with its own `migrations_dir`, and is a separate piece of work.
5. **Two member screens now overlap** in Settings (resolution 18): the refresh's member table and PR #66's `MembersPanel`.

## 9. What I did not do, and why

- Did not merge, close or delete anything, and did not deploy, change secrets or apply migrations.
- Did not carry PR #72 (superseded, and merging it is textually clean, so it would add a second landing) or PR #75 (superseded).
- Did not carry local `sec/domain-txt-proof-ui` af109e0: no Worker code produces its API yet (resolution 6). PR #74's migration is in, so until the Worker half exists a second user can hold a pending claim on a hostname another user has pending (an active hostname stays unique). The Worker still refuses a duplicate at claim time with its global check; only the insert-race backstop is weaker.
- Did not carry commit 78aacf4 (UI brief, marked "drop before any PR"), `NOTES.md` from the old one-composer branch, or any `champ-backup` snapshot.
- Did not renumber migrations (resolution 25), did not rewrite history, did not touch the dirty shared checkout.
- Did not add features: the only additions are test re-adds, the CI step and the glue the merges needed.

## 10. Conflict resolutions

1. PR70 + PR69, CLOUDFLARE_DEPLOY.md section 2: kept PR70's Workers Builds table and `--env=""` deploy command; dropped PR69's older one-line deploy example and its trailing "Workers Builds:" line (it said `npx wrangler deploy` without `--env=""`, which PR70 shows must be pinned). PR69's placeholder rule kept (no live Google client id).
2. PR60, worker/wrangler.jsonc top level: kept BOTH main's `send_email` EMAIL binding (password reset) and PR60's zone `routes` for Cloudflare for SaaS. They are independent keys.
3. PR67 (stacked on PR60), frontend/src/pages/SettingsPage.tsx, 3 hunks: icon import kept main's superset (Building2, Copy); `useOrgContext()` destructure is the union `{ orgId, inOrg, permissions, profile }` (PR67 needs orgId for the domains query key, the refresh needs the rest); root className is `beam-settings cb-domain-settings` (the refresh grid plus PR67's DNS styling; PR67's `max-w-4xl mx-auto py-8 px-4` dropped because the refresh grid owns the layout).
4. PR67, frontend/src/pages/SettingsPage.test.tsx: both branches own a test file at this path. Kept BOTH: the refresh's Personal/organization grouping tests moved to `SettingsPage.groups.test.tsx`, PR67's Domain DNS handoff tests stay at `SettingsPage.test.tsx`. PR67's stale `vi.mock('@clerk/react')` replaced by `vi.mock('../lib/authClient')` because Clerk was removed from the frontend.
5. PR74 (after PR60), worker/src/db/schema.ts domains table: kept both columns, `cfDnsRecords` (PR60, migration 0008_domain_dns_records) and `verificationToken` (PR74, migration 0010). Migration files keep their original names: they are independent and additive, and a database that already applied a branch migration (staging QA did) will not re-run it under a new name.
6. Local-only sec/domain-txt-proof-ui af109e0 (TXT ownership proof in Settings) NOT carried: it rewrites SetupInstructions, which PR67 has rewritten completely (3 conflicted files), and its API contract (domain.txt_name, txt_value) has no producer: the Worker half, card t_43be35ca, has no code. Redo it on PR67's DNS-records table once the Worker piece exists. Commit stays on local branch sec/domain-txt-proof-ui and in worktree t_9390a3a2.
7. PR64 backend, carried via its rebased copy `rebase/pr64-on-0ef93a5` (same five commits as PR64's head `feat/self-serve-orgs`; PR66 and the cherry check below prove the equivalence), onto the refresh and PR60/74. worker/src/db/schema.ts: kept `cfDnsRecords`, `verificationToken` and PR64's `legacyPlatformBefore`.
8. PR64, worker/wrangler.jsonc: staging and deepify `vars` keep the refresh's `AUTO_JOIN_EMAIL_DOMAINS` and gain PR64's `SUPER_ADMIN_EMAILS`.
9. PR64 + refresh (audit run-5), worker/src/auth/betterAuth.ts, the auth judgment calls: (a) password-reset hardening (`revokeSessionsOnPasswordReset`, API keys revoked on reset) kept from the refresh; (b) `user.create.before` (service+ addresses cannot self-register) and `after` (join the default org only for a VERIFIED address on the allowlist) kept from the refresh. This is compatible with PR64's "personal by default": a non-allowlisted or unverified sign-up joins nothing, and Deep's 20 Nov ruling (championsmail.com and lakeb2b.com auto-join) stands; (c) `allowUserToCreateOrganization` is PR64's `isSuperAdmin` (Deep's 6 Nov ruling: org creation is super admin only) instead of the refresh's blanket `false`, which would have blocked the super admin too; (d) `requireEmailVerificationOnInvitation` is `true` (refresh, audited later) instead of PR64's `settings.emailEnabled`: production and staging both declare the EMAIL binding so invites still work there, and an unverified account can never accept an invitation, even on a deployment with no mailer; (e) PR64's invitation expiry, 5000-member cap, `sendInvitationEmail` and slug hooks kept.
10. PR64, worker/test/betterAuth.test.ts: kept the refresh's tests (unverified sign-up joins no default org; verified allowlisted address joins as member; off-domain does not; session lands in the member's org) and added PR64's "a new sign-up holds no membership anywhere" test as its own case so no test from either branch is lost.
11. PR66 (UI, stacked on PR64) worker files (betterAuth.ts, schema.ts, betterAuth.test.ts, wrangler.jsonc): PR66 has zero worker changes beyond PR64's five commits, so every conflict was the old-PR64-vs-rebased-PR64 difference; took V2's already resolved side. `DEFAULT_ORG_SLUG` (needed by the refresh's join hook, dropped by PR64) restored.
12. PR66 + refresh, org slug rename: the refresh removed `organization:update` from the admin role (a rename of the default org would redirect every sign-up; test `auditRun5.test.ts` proves an admin cannot rename). PR66's UI never calls rename, so the refresh wins. PR64's test "refuses renaming an org's slug to a reserved word" now expects 403 (refused before the slug hook), with the hook kept as defence in depth.
13. PR66 invitations: PR64/66 test accepted an invite on an UNVERIFIED account. With `requireEmailVerificationOnInvitation: true` (decision 9d) the test now first proves the unverified accept is refused (403, still no membership), then verifies the email and accepts.
14. PR66 frontend, OrgSwitcher.tsx: kept the refresh's sidebar trigger styling and added PR66's role badge, search reset on close (`onOpenChange`) and wider menu (w-72).
15. PR66, main.tsx: both stylesheets imported (`product-refresh.css`, `components/org/org.css`).
16. PR66, AuthPages.tsx: kept the refresh's forgot-password banner and `rejected` hint; sign-up link keeps PR66's `?next=` pass-through of the query string.
17. PR66, HomePage.tsx: refresh hero and Recent shares cards kept; PR66's `<OnboardingChecklist />` placed under the composer. HomePage.test.tsx mocks the checklist (it needs a QueryClient and the auth client).
18. PR66, OrganizationSettings.tsx: refresh layout (collapsible permissions, member search table with eligible leaders only, adoption panel) kept; PR66's `<MembersPanel>` (members, invites, roles) added above it. Known overlap for Deep's UI call: both now list members; the refresh table is read-mostly with team assignment, MembersPanel is the manage surface. AccountReporting.test.tsx expects the heading "Members and teams" (the refresh's), not PR66's "Teams".
19. PR66, SettingsPage.tsx (7 hunks): icon import is the refresh's list minus `Copy` and `Star` (unused after the merge); PageHeader kept with PR66's `CreateOrgEntry` as its `actions`; `useAppConfig` gates custom-domain cards (PR66); DomainRow's "Primary" badge dropped in favour of PR66's `DefaultToggle`; the DNS setup block is PR67's `SetupInstructions` (server `dns_records` including TXT, "Copy all for IT", Download .txt), NOT PR66's CNAME-only `DnsRecordsCard`, which would hide the TXT ownership records. PR66's `DnsRecords.tsx`/`selfServeRules.dnsRecordsFor` stay in the tree with their tests, now unused by Settings.
20. PR66 vs PR67 tests: PR67's DNS test uses status label "Pending" (PR66 relabelled `pending_cname`) and mounts `/settings?tab=domains` (the refresh made Appearance the default tab).
21. PR61 (admin-managed email-domain auto-join) vs the refresh's env allowlist, a membership decision that stays Deep's: PR61 on its own replaces the env rule with an empty table, which would silently drop Deep's 20 Nov ruling (championsmail.com and lakeb2b.com join). Merged as ADDITIVE: the env allowlist still joins verified addresses at creation (refresh behaviour), any other verified address falls to PR61's `joinOrgByEmailDomain` (admin-managed list, once per user via `org_join_checked_at`). The session-create hook runs PR61's join first, then the refresh's "land members in their org" pick. The env-allowlist join now also sets `org_join_checked_at`, so an admin removal cannot be undone by a later domain-list join (new test in betterAuth.test.ts). `DEFAULT_ORG_SLUG` stays exported (assistant.ts uses it; PR61 deleted it).
22. PR61, betterAuth.test.ts: kept the refresh's tests; PR61's "unlisted domain joins no org" case is the same assertion as PR64's "holds no membership anywhere" test already kept.
23. PR61, frontend/src/api/org.ts: union of the refresh's adoption API and PR61's email-domain calls. SettingsPage: `EmailDomainsSettings` renders under `OrganizationSettings` in the Organization tab, still gated on `org.domains.manage`.
24. PR63 (attribution slice 1), worker/src/routes/_utmAnalytics.ts company-intent query: kept main's `REAL_CLICK` UA/bot filter AND PR63's `ce.is_scanner = 0` (the two are complementary: UA text versus the recorded scanner flag). docs/API.md: PR63's attribution paragraph plus main's update-in-place paragraph.
25. Migration numbering (hotspot): V2 carries `0004_attribution_slice1`, `0008_domain_dns_records`, `0009_org_email_domains`, `0009_self_serve_orgs`, `0010_domain_claim_token` on top of main's 0001 to 0008. Names were NOT renumbered: wrangler applies by name, `wrangler d1 migrations list` (read-only, run 22 Nov) shows production still has SIX unapplied (the five above plus the Intranet's `0009_intranet`, resolution 29) and staging has applied `0009_self_serve_orgs` already, so renaming would re-run it on staging. The five are independent and additive; the Worker suite builds the schema from all migrations in sort order and passes.
26. PR68 (visitor IP and stored company on owner analytics), frontend/src/components/layout/Sidebar.tsx: the refresh moved the whole Recent opens bell into `ui/NotificationsTray.tsx`, so the Sidebar hunk took the refresh's side and PR68's one change (company name and IP before the location in each row) was ported into `NotificationsTray.tsx`. Not reviewed line by line against the "same IP is not one person" wording in the new analytics: flagged for Deep's UI pass.
27. PR62 (visitor journeys UI): merged textually clean except ShareComposer.test.tsx (took the refresh's `readyInput` helper; PR62's change was only a longer timeout). Both PR62 and the refresh rewrite AnalyticsPage: no textual conflict, so the check is the test run plus a visual pass (see "not done"). Two semantic fixes after the merge: JourneysSection used `LoadingSpinner`, which the UI redo (#71) turned into a `role="status"` table skeleton, so the section now renders `TableSkeleton` with its own label (one status element, PR62's test unchanged); and PR68's LinkAnalyticsPage test now stubs `JourneysSection` (the page embeds it after PR62 and the test has no QueryClient).
28. PR75 (deflake test_versions_rollback_and_prune) NOT merged, superseded: PR66's commit 1808052 ("Fix flaky HTML replace assertion: judge version markers on the page body", already in V2) fixes the same assertion more robustly (`document_body` plus a fixed visitor cookie). Merging PR75 conflicted on exactly those lines; the V2 side is kept.
29. `feat/intranet-cloudflare` (14 commits, 76 files, contains intranet-p0/p1/p2) carried as UNIQUE WORK. It is a separate deployment (Worker `champbeam-intranet`, own D1 and R2, `INTRANET_MODE=true` gates every public route off) that lives in this repo as the `intranet` wrangler env; a deployment already exists on Deep's account. It is not in any open PR, so it is the last merge. Reverting that merge commit removes the code but NOT the coupling: see the next paragraph. Conflicts: frontend/.env.example (HEAD plus the `VITE_APP_MODE` note); worker/src/app.ts (both import sets); worker/wrangler.jsonc (staging vars from HEAD, then the whole `intranet` env block); worker/src/auth/betterAuth.ts, `createAuth(env, db, waitUntil, opts)` with the intranet `AuthOptions`, and `user.create` now runs, in order: service+ refusal, intranet invite check (intranet mode only), then in `after` the intranet invite redemption (intranet mode returns early) or the ChampBeam join rules. In non-intranet mode behaviour is unchanged. The `intranet` env's D1 uses the shared `migrations` dir, so it also receives V2's migrations when `db:migrate:intranet` is next run, and the reverse holds too: `0009_intranet.sql` (ALTER `organization_memberships` plus `transfers`, `decision_log` and its triggers, `org_review_settings`, `org_invites`, `agent_benchmarks`) is in the list production applies, and the shared `schema.ts` (lines 82-83) selects its columns in whole-row queries (`services/org.ts` lines 81 and 96). The earlier wording of this resolution ("does nothing in the ChampBeam Worker unless INTRANET_MODE=true", "one revert removes it cleanly") was wrong and is withdrawn; the routes are gated, the schema is not.
30. PR62 committed 31 QA files under `docs/journeys-evidence/` (screenshots, audit JSON, VERIFICATION.md). The repo is PUBLIC and the standing rule is that verification evidence goes on the PR as attachments, never in a commit, so V2 removes the directory in its own commit. The files remain in PR #62's branch history, and in V2's history because PR62's commits are merged whole: a squash merge of V2 is the only way to keep them out of `main` history.
31. CI: the `worker` job runs `npx vitest run` only, so the 56 Intranet tests (a second vitest config) would not gate anything. Added one step, `npx vitest run -c vitest.intranet.config.ts`, matching the `npm test` script that already runs both.
32. Test accounting: a title-by-title comparison of every test on every carried branch against V2 found one test lost in the auto-merge (the refresh's `users cannot create organizations through the Better Auth API`, still valid for a non-super-admin): re-added. Renamed, not lost: PR64's and PR61's "sign-up is personal / unlisted domain joins no org" (one case, "a new sign-up is personal: it holds no membership anywhere") and the refresh's ShareComposer "admin-like session role" title.
