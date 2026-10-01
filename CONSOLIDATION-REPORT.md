# ChampBeam Consolidation Report

Branch: **`v2-consolidation`** @ `74404c8`
Base: `feat/pages-v2-links-assistant` @ `5ccf66f`
Repo: `Champ-Deep/ChampBeam` (public). Repo id 1179794433, formerly named
ChampUTM. `main` was not modified. No branches were deleted. PR #28 was not
touched.

---

## 1. Repo identity

`Champ-Deep/ChampUTM` is the same repository (id 1179794433) and GitHub has
already renamed it. `ChampUTM` now redirects. There is no separate repo to
migrate. All work here is in the single `Champ-Deep/ChampBeam` repo.

Clone: `git@github.com:Champ-Deep/ChampBeam.git`
Working clone: `/Users/deep/Apps&Projects/ChampBeam-v2`

---

## 2. Per-branch verdicts

I read real diffs for all five branches rather than inferring from names.

| Branch | SHA | Verdict | Basis |
| --- | --- | --- | --- |
| `main` | `5e26adc` | **KEEP** | Default branch. |
| `feat/pages-v2-links-assistant` | `5ccf66f` | **SUPERSEDED, safe to delete after merge** | Sole source of new work. Rebased onto as the branch base. |
| `claude/gracious-johnson-a8vcfn` | `bb4ee80` | **SAFE-TO-DELETE** | Already an ancestor of `main`. |
| `claude/friendly-turing-tiwr9b` | `9f94867` | **SAFE-TO-DELETE** | Already an ancestor of `main`. |
| `preview/deepify-backend` | `a59ad5f` | **SAFE-TO-DELETE** | Already an ancestor of `main`. |

### The two similarly-named `claude/*` branches

These were **not** duplicates and were **not** sequential agent runs of the same
task. They are two distinct ancestor branches with a strict linear
relationship:

```
9f94867 (friendly-turing)  ...114 commits...  bb4ee80 (gracious-johnson)  ...main
```

- `merge-base(friendly-turing, gracious-johnson)` = `9f94867`, which is
  **exactly** `friendly-turing`'s own tip. `friendly-turing` is therefore an
  ancestor of `gracious-johnson`: a strictly earlier, fully contained branch.
- `git log main..gracious-johnson` returns **zero commits**. Its 148 commits are
  all already in `main`.
- `gracious-johnson` is the substantive one: RBAC, the content library, BYOD
  domains, geo-enrichment fixes, the canonical test suite, and the Deepify
  migration prep. `friendly-turing` is its earlier checkpoint (ChampVault
  connector, rebrand, VPS deploy kit).

Neither is agent junk. Both are simply **already merged**, which is why they hold
nothing unique. The real content of both survives in `main` and therefore in
`v2-consolidation`.

### Merge decisions

| Branch | Decision | Why |
| --- | --- | --- |
| `feat/pages-v2-links-assistant` | **Folded in as the base** | The only branch with work not in `main`. 3 commits, 36 files, +3252/-54. Clean fast-forward over `main` (`behind=0`), so no merge commit and no conflict resolution was needed or invented. |
| `claude/gracious-johnson-a8vcfn` | **No action needed** | `merge-base --is-ancestor` into `main` already true. Its content arrives transitively through `main`. |
| `claude/friendly-turing-tiwr9b` | **No action needed** | Same, and an ancestor of `gracious-johnson` as well. |
| `preview/deepify-backend` | **No action needed** | Ancestor of `main`. Docs, Postman, DNS runbook. |

Folding the three already-merged branches in again would have been a no-op: they
are ancestors, not siblings. Recording that is the honest outcome, and it is why
`v2-consolidation` contains exactly one merge decision rather than four.

---

## 3. Verification: real output

All commands run on this machine, Node v24.13.1, Python 3.13 in
`backend/.venv`.

### Backend

```
$ .venv/bin/python -m pytest tests/ -q -p no:warnings
........................................................................ [ 39%]
........................................................................ [ 78%]
........................................                                 [100%]
184 passed in 21.01s
```

**184 passed.** 178 pre-existing on the branch, plus 6 new. Before my changes
the same suite reported 178 passed.

### Frontend tests

```
$ npm test
 ✓ src/api/_shared.test.ts (8 tests)
 ✓ src/hooks/useTheme.test.ts (8 tests) 19ms
 ✓ src/components/AppearanceSettings.test.tsx (2 tests) 66ms
 ✓ src/lib/format.test.ts (5 tests) 10ms
 ✓ src/components/SystemSettings.test.tsx (4 tests) 86ms

 Test Files  5 passed (5)
      Tests  27 passed (27)
```

### Typecheck

```
$ npx tsc -b
TYPECHECK CLEAN (exit 0)
```

### Build

```
$ npm run build
vite v7.3.1 building client environment for production...
✓ 2886 modules transformed.
dist/index.html                     0.81 kB │ gzip:   0.42 kB
dist/assets/index-B5OgIEXt.css     56.13 kB │ gzip:  10.49 kB
dist/assets/index-Cm2me8vu.js   1,056.94 kB │ gzip: 300.71 kB
✓ built in 4.12s
```

Build succeeds. It emits the >500 kB chunk warning, which is pre-existing and
tracked as improvement-plan item 10.

### Two corrections I am obliged to state

**The suite runs on SQLite, not Postgres.** I pointed `DATABASE_URL` at a real
Postgres 15 container and re-ran: 184 passed, and `\dt` on that database showed
`Did not find any relations`. `tests/conftest.py` overrides the sessionmaker to
in-memory SQLite, so `DATABASE_URL` changes nothing. Any claim that the suite
exercises Postgres would have been false. This is tracked as plan item 13.

**The Postgres NULL-ordering claim was proven directly, not via pytest.** I ran
it in `psql`, because SQLite sorts NULLs the other way and cannot detect it:

```sql
-- table t: (1,'abc',NULL), (2,NULL,'abc')
SELECT id FROM t WHERE short_code='abc' OR alias='abc'
  ORDER BY (short_code='abc') DESC LIMIT 1;              -- id 2  (WRONG)
SELECT id FROM t WHERE short_code='abc' OR alias='abc'
  ORDER BY (short_code='abc') DESC NULLS LAST LIMIT 1;  -- id 1  (right)
```

---

## 4. What I implemented

Three fixes, each with a test that **failed before and passes after**. New file:
`backend/tests/test_v2_hardening.py`.

### Fix 1: named links could take any shared link offline (the serious one)

`_lookup_link` resolved `/r/{key}` and `/s/{key}` as `short_code == key OR alias
== key`, then called `scalar_one_or_none()`. The code comment claimed the two
namespaces were "practically disjoint". They are not: aliases accept 3 to 60
chars of `[a-z0-9-]`, short codes are 7 chars of `[A-Za-z0-9]`. A key can match
one link's short code and a **different** link's alias.

Two rows matched. Reproduced failure, before the fix:

```
sqlalchemy.exc.MultipleResultsFound: Multiple rows were found when one or none was required
ERROR app.main:main.py:171 Unhandled exception on GET /r/37700a
```

The public redirect returned **500 for every visitor**. Any user who could mint a
link could name it after a victim's short code and take that link offline. This
is a cross-tenant availability defect on the product's most valuable asset.

Fix: order by `(short_code == key).desc().nulls_last()` with `limit(1)`. The
canonical short-code match always wins, and the result set can never exceed one
row, so the crash is structurally impossible rather than merely unlikely.

`nulls_last()` is load-bearing, not decoration: `short_code` is nullable and
Postgres sorts NULLS FIRST under `DESC`, so without it a NULL-code row with a
matching alias would outrank the genuine owner. Proven in `psql` above.

### Fix 2: link auto-mapping crossed domain boundaries

`_page_resolver` filtered `domain_id IS NOT NULL` when the page being edited had
a custom domain. That admits the user's pages on **every** custom domain, so
auto-map rewrote hrefs to `/p/{slug}` addresses that do not resolve on that
host. On a BYOD setup, page links silently point at 404s. Now compares
`domain_id` for equality.

### Fix 3: the advertised rate limit did not exist

`rate_limit.py` builds a slowapi `Limiter` with `default_limits=["100/minute"]`,
but slowapi applies defaults only through `SlowAPIMiddleware` or a
`@limiter.limit` decorator. The app installed neither, and `app.user_middleware`
was `['BaseHTTPMiddleware', 'CORSMiddleware']`. Proven by flooding:

```
GET /health x250 -> {200: 250}
429s: 0 (rate limit NOT enforced)
```

Metered `/assistant/chat` at 20/minute, where every call bills a model provider.

**Deliberately not done:** installing the global middleware. `/r/`, `/s/` and the
serve path are hot paths; one shared link behind a corporate NAT can legitimately
exceed 100 requests/minute, and a blanket 429 there breaks live links. I traded
complete coverage for not breaking production, and left the reasoning in the code
so the next reader does not "fix" it the wrong way.

### Red-green evidence

```
Before fixes:  4 failed, 1 passed
After fixes:   184 passed (full suite, no regressions)
```

Two existing tests (`test_redirect_endpoint_mocked`,
`test_r_redirect_survives_click_tracking_failure`) broke on my first attempt
because their mock session only implements `scalar_one_or_none()`. Rather than
edit tests to suit my change, I used `scalar_one_or_none()` with `limit(1)`, which
is safe because the limit guarantees one row, and the doubles keep working
untouched.

---

## 5. Improvement plan summary

Full detail in `docs/IMPROVEMENT-PLAN-V2.md`. 13 items, ordered by risk.

**P0, correctness and security**
1. Alias/short-code namespace collision. **Shipped.**
2. Auto-map crossing domains. **Shipped.**
3. Rate limit not enforced. **Shipped.**
4. **`AssistantConfig` is a global singleton with no `org_id`, and the admin gate
   is `user.org_id is None or user.org_role == "admin"`.** Any signed-in user with
   no org passes, so any personal-account user can `PUT /assistant/config` and
   change the provider, model and enabled flag for the entire deployment, or turn
   the assistant off for everyone. Proposed, **not shipped**: the fix needs a real
   platform-admin flag established first, and shipping enforcement before that
   would lock Deep himself out. This is the highest-value open item.

**P1, feature completeness**
5. Four large new frontend surfaces (`PagesPage`, `AssistantDrawer`,
   `UtmUrlBuilder`, `ShareFilePanel`) shipped with zero tests.
6. Aliases can permanently squat another link's short code.
7. Batch publish has no aggregate size ceiling (50 x 2 MB = 100 MB per request,
   and it is on the service-key write allowlist).

**P2, polish and process**
8. No CI at all. 9. Playwright specs exist but run manually.
10. 1.06 MB single JS chunk. 11. 20 npm audit vulnerabilities (1 critical).
12. `datetime.utcnow()` deprecated, 1,138 warnings.
13. The suite never exercises Postgres.

Explicitly not recommended: a global rate-limit middleware, dropping
`script-src 'unsafe-inline'` from the hosted-page CSP (breaks real customer
pages, needs a per-asset script manifest first), and any large new product
surface on this branch.

---

## 6. Deletion manifest

Verification command, run against the pushed branch, for every non-V2 branch:

```bash
git merge-base --is-ancestor origin/<BRANCH> origin/v2-consolidation && echo contained
```

| Branch | Proof | Unreachable commits | Verdict |
| --- | --- | --- | --- |
| `feat/pages-v2-links-assistant` | `contained` | 0 of 177 | **SAFE-TO-DELETE** once `v2-consolidation` is merged |
| `claude/gracious-johnson-a8vcfn` | `contained` | 0 of 148 | **SAFE-TO-DELETE** now |
| `claude/friendly-turing-tiwr9b` | `contained` | 0 of 114 | **SAFE-TO-DELETE** now |
| `preview/deepify-backend` | `contained` | 0 of 159 | **SAFE-TO-DELETE** now |
| `main` | `contained` | n/a | **KEEP** (default branch) |

Independent cross-check with `git rev-list <branch> --not v2-consolidation`:

```
claude/gracious-johnson-a8vcfn: 148 commits, 0 not reachable from v2-consolidation
claude/friendly-turing-tiwr9b: 114 commits, 0 not reachable from v2-consolidation
preview/deepify-backend:       159 commits, 0 not reachable from v2-consolidation
feat/pages-v2-links-assistant: 177 commits, 0 not reachable from v2-consolidation
```

**Zero commits on any branch are unreachable from `v2-consolidation`.** Two
independent methods agree.

**Timing caveat, and it matters.** `feat/pages-v2-links-assistant` is contained
only because `v2-consolidation` was branched from it. If Deep merges
`v2-consolidation` and then merges PR #28, the PR becomes empty and GitHub may
auto-close it. Deleting `feat/pages-v2-links-assistant` **before** merging
`v2-consolidation` would leave PR #28 pointing at a deleted head. Recommended
order: merge `v2-consolidation` first, close #28 deliberately, then delete.

Nothing was deleted. Deep reviews first.

---

## 7. Known gaps in this deliverable

**AGENTS.md was not written.** The workspace has a protection guard on
`AGENTS.md` that requires interactive approval, which timed out. Per the guard's
instruction I did not retry it or route around it via another tool. The content
is drafted and ready: repo map, commands, conventions, and the gotchas that
actually cost time here (SQLite-vs-Postgres NULL ordering, the inert rate limit,
the two overlapping link namespaces, the global assistant singleton). It needs
either an approved write or Deep pasting it in.

**LICENSE** already exists and is MIT (Copyright 2026 Champ-Deep). Verified, not
modified.

**No `CONTRIBUTING.md`** exists. Not required by the task, noted for completeness.