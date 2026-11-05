# ChampBeam V2: Improvement Plan

Status: proposed, not scheduled. Written during the `v2-consolidation` review of
`feat/pages-v2-links-assistant` against `main`.

Scope note: every item below was found by reading the code and, where marked
**[verified]**, by running it. Items are ordered by risk, not by effort:
correctness and security first, then the Pages V2 / Assistant feature, then
product polish.

---

## How to read this

| Column | Meaning |
| --- | --- |
| **Effort** | S = under an hour. M = under a day. L = multi-day. |
| **Risk** | Risk of shipping the fix, not of leaving the bug. |
| **State** | Shipped on `v2-consolidation`, or proposed. |

Effort and risk are both estimates. The "verified" claims are not.

---

## Baseline: where the project actually stands

Measured on `v2-consolidation`, not assumed:

- Backend: 76 modules, 33 test files, **184 tests passing**.
- Frontend: 64 source files, **5 test files, 27 tests passing**.
- `npm run build` (tsc + vite) succeeds; typecheck is clean.
- LICENSE is present and is MIT.
- **No CI.** There is no `.github/workflows` directory. Nothing runs on push or
  on PR.
- **No AGENTS.md and no CONTRIBUTING.md.**

That shape is the single most important fact in this document. The backend is
well covered relative to its size; the frontend has 5 test files against 64
source files, and the two largest new frontend surfaces from the V2 branch
(`PagesPage.tsx` at ~294 changed lines and `AssistantDrawer.tsx` at 284) shipped
with no tests at all. With no CI, nothing prevents that ratio from worsening.

---

## P0: Correctness and security

### 1. Named links could take any shared link offline **[verified, shipped]**

`/r/{key}` and `/s/{key}` resolve a key as `short_code == key OR alias == key`.
The code assumed those two namespaces were disjoint and called
`scalar_one_or_none()`. They are not: aliases accept 3 to 60 characters of
`[a-z0-9-]`, short codes are 7 characters of `[A-Za-z0-9]`, so a key can match one
link's short code and a *different* link's alias.

Two rows matched, SQLAlchemy raised `MultipleResultsFound`, and the public
redirect returned **500 for every visitor**. Reproduced:

```
sqlalchemy.exc.MultipleResultsFound: Multiple rows were found when one or none was required
ERROR app.main:main.py:171 Unhandled exception on GET /r/37700a
```

Any user able to mint a link could name it after a victim's code and take that
link offline. This is a cross-tenant availability defect on the product's most
valuable asset.

**Fix:** order by `(short_code == key).desc()` with `nulls_last()` and
`limit(1)`, so the canonical short-code match always wins and the result set can
never exceed one row. `nulls_last()` is load-bearing: `short_code` is nullable
and Postgres sorts NULLS FIRST under `DESC`. Verified on real Postgres 15:

```
ORDER BY (short_code = 'abc') DESC           -> id 2 (short_code IS NULL)   # wrong
ORDER BY (short_code = 'abc') DESC NULLS LAST -> id 1 (short_code = 'abc')   # right
```

**Effort:** S. **Risk of fixing:** low. The added `ORDER BY` runs on an
already-indexed `short_code`; a redirect that previously 500'd now resolves.
Behaviour for every unambiguous key is byte-identical.

**Residual risk, not fixed here:** there is still no cross-namespace constraint
at the database level. A user can *permanently* claim a name that is currently
only a random code. Worth a check on creation, noted as item 6.

### 2. Link auto-mapping crossed domain boundaries **[verified, shipped]**

`_page_resolver` filtered `domain_id IS NOT NULL` when the page being edited had
a custom domain. That admits the user's pages on **every** custom domain, so
auto-map rewrote internal hrefs to `/p/{slug}` addresses that do not resolve on
that host. On a BYOD setup the page links silently point at 404s.

**Fix:** compare `domain_id == domain_id`. **Effort:** S. **Risk:** low. It
narrows the candidate set; nothing that previously worked on the *correct*
domain stops working.

### 3. The rate limit the app advertises was not enforced **[verified, shipped]**

`app/middleware/rate_limit.py` constructs a slowapi `Limiter` with
`default_limits=["100/minute"]`, but slowapi only applies `default_limits`
through `SlowAPIMiddleware` or a `@limiter.limit` decorator. The app installed
neither, and `app.user_middleware` was `['BaseHTTPMiddleware', 'CORSMiddleware']`.
Proven by firing 250 requests at `/health`: **250 x 200, zero 429s.**

This matters most on `/assistant/chat`, where every call bills a third-party
model provider. An unmetered loop is a direct, immediate cost.

**Fix:** `@limiter.limit("20/minute")` on `/assistant/chat` only.

Deliberately **not** done: installing the global middleware. `/r/`, `/s/` and the
page serve path are a hot path, and one shared link behind a corporate NAT can
legitimately exceed 100 requests/minute. A blanket 429 there breaks live links
to protect against a threat that does not apply. Meter the endpoints that cost
money; leave the hot path alone. The inert `default_limits` value is still in
the config and still misleading; removing or documenting it is item 8.

**Effort:** S. **Risk:** low, and reversible by deleting one decorator.

### 4. The Assistant is a global singleton any user can reconfigure **[verified, proposed]**

`AssistantConfig` is a single row with `id = 1` and **no `org_id`**. The gate is:

```python
def _is_admin(user: TokenData) -> bool:
    return user.org_id is None or user.org_role == "admin"
```

Any signed-in user with **no org** passes this check. That is every
personal-account user, not just a platform operator. So any user can `PUT
/assistant/config` and change the provider and model **for every other user of
the deployment**, and can set `enabled = false` to switch the assistant off for
everyone.

Verified by reading the model (no `org_id` column) and the gate. Not exploited
in a live environment.

**Fix:** two parts. (a) Make the config org-scoped: add `org_id`, one row per
org plus a platform default row, and resolve by the caller's org. (b) Replace the
"no org means admin" rule with an explicit platform-admin flag, because the
current rule grants privilege by *absence* of a field, which is backwards.

**Effort:** M, plus a migration. **Risk: MEDIUM.** This changes who can write
shared state. If Deep is the only operator, shipping (b) without first setting a
real platform-admin flag locks himself out. Sequence: set the flag, then enforce.

**This is the highest-value item in the document and the one most likely to
bite if rushed.** It is proposed, not shipped, for exactly that reason.

---

## P1: Pages V2 and Assistant feature completeness

### 5. The two largest new frontend surfaces have no tests **[verified, proposed]**

`PagesPage.tsx` (+294 lines), `AssistantDrawer.tsx` (284), `UtmUrlBuilder.tsx`
(224), `ShareFilePanel.tsx` (+199). Four substantial UI surfaces, zero tests.
The backend half of the same feature shipped with 4 new test files and 556 test
lines, so the standard here is clearly known and simply was not applied on the
frontend.

Start with `UtmUrlBuilder`: it is pure derivation logic (URL + params in, tagged
URL out) and is the easiest thing in the repo to test properly.

**Effort:** M. **Risk:** low. Additive.

### 6. Aliases can permanently squat another link's short code **[verified, proposed]**

Item 1 stops the 500. The squatting remains: because nothing checks the alias
against the `short_code` namespace, a user can claim a name that happens to be
someone's random code, and the victim is stuck with a 500-shaped ambiguity.

**Fix:** on alias create/update, reject an alias that collides with an existing
`short_code` in the same domain namespace, with a clear 409. Requires a new
migration for a cross-column constraint if you want it airtight at the DB level.

**Effort:** S for the application check, M for the DB constraint. **Risk:** low
for the app check, medium for the migration (it can fail on existing data, so it
needs a pre-flight query).

### 7. Batch publish has no aggregate size ceiling **[verified, proposed]**

`POST /api/v1/pages/batch` caps the file **count** at 50 and validates each file
individually against `pages_max_bytes` (2 MB). There is no cap on the total.
50 x 2 MB = 100 MB accepted into memory in one authenticated request, and the
endpoint is on the `X-Service-Key` write allowlist, so it is reachable
server-to-server by design.

**Fix:** a `pages_batch_max_total_bytes` setting, enforced before any blob write,
returning 413 with the limit named.

**Effort:** S. **Risk:** low. Set it generously (256 MB) so no legitimate batch
breaks.

---

## P2: Product polish and process

### 8. No CI **[verified, proposed]**

Nothing runs on push or PR. Every defect in P0 was found by hand, and all of
them are the kind a 20-second job catches: `pytest`, `vitest`, `tsc -b`.

Add `.github/workflows/ci.yml` running the backend suite, the frontend suite,
and the typecheck. Do not add the Playwright e2e specs yet (see item 9).

**Effort:** S. **Risk:** low, and it is the multiplier on everything else here.

### 9. Playwright specs exist but are not wired to anything **[verified, proposed]**

Three specs in `frontend/e2e/` (`api-smoke`, `app-smoke`, `authed`). No workflow
runs them, and they need a live backend plus Clerk credentials, so they cannot
be CI-gated as-is.

**Fix:** either mark them explicitly as manual (`test:e2e` is already a separate
npm script) or stand up a throwaway backend for CI. Until then, add a line to
`docs/TESTING.md` saying they are manual and require credentials, so nobody
assumes they are enforced.

**Effort:** S. **Risk:** low.

### 10. The frontend bundle is 1.06 MB in a single chunk **[verified, proposed]**

`npm run build` warns: `dist/assets/index-*.js  1,056.94 kB | gzip: 300.71 kB`.
300 KB gzipped on first paint for an app whose main job is generating links.
Recharts and the Clerk bundle dominate.

**Fix:** route-level `React.lazy` plus a `manualChunks` split for
recharts/Clerk. **Effort:** M. **Risk:** low, but verify the lazy boundaries do
not break the shell layout.

### 11. 20 npm audit vulnerabilities, 1 critical **[verified, proposed]**

`vitest` (critical), `axios` (high), `react-router-dom` (high), `vite` (high),
plus transitive `postcss`, `nanoid`, `js-yaml`, `form-data`. These are
**devDependencies** for most of them (`vitest`, `vite`, `postcss`), which lowers
production risk, but `axios` is a runtime dependency.

**Fix:** `npm audit fix` for the safe range now; triage `axios` and
`react-router-dom` separately as runtime deps, checking for breaking changes
rather than blind `--force`. **Effort:** S to hours. **Risk:** medium for the
runtime two, low for dev tooling.

### 12. `datetime.utcnow()` is deprecated across the codebase **[verified, proposed]**

The test run emits 1,138 warnings, most of them this. It will break on a future
Python. Purely mechanical, but wide, so it wants its own commit and its own PR.

**Effort:** M. **Risk:** low, but only if done in isolation. Naive timezone
changes on click timestamps are the classic way to shift analytics by hours.

### 13. The suite runs on SQLite; Postgres is never exercised **[verified, proposed]**

`tests/conftest.py` redirects every session to in-memory SQLite. Postgres-only
behaviour is therefore untested, and one such case already bit during this
review: the SQLite and Postgres NULL-ordering difference in item 1 is invisible
to the suite. I checked this by pointing `DATABASE_URL` at a real Postgres 15
and confirming the schema in that database stayed empty: the override wins.

**Fix:** add an opt-in Postgres job (the container is 30 lines of YAML) and mark
the tests that are dialect-sensitive.

**Effort:** M. **Risk:** low, but expect genuine failures on first run. Those
failures are the point.

---

## Recommended order

1. Items 1, 2, 3: shipped on `v2-consolidation`, already tested.
2. Item 8 (CI): do this next, before anything else, so the rest cannot regress.
3. Item 4 (Assistant scoping): sequence the platform-admin flag first.
4. Items 6, 7: small, self-contained, close real holes.
5. Item 5 (frontend tests): worth it, and unblocks confidence in item 10.
6. Items 9 to 13: process and polish.

## Explicitly not recommended

- **A global rate-limit middleware.** Item 3 explains why. The hot path would
  break.
- **Dropping `script-src 'unsafe-inline'` from the hosted-page CSP.** It would be
  a genuine hardening win, but it breaks real customer pages that rely on inline
  script, and it needs a per-asset external-script manifest first. Weeks, not
  days. Track it, do not bundle it with a bugfix branch.
- **Any large new product surface on the consolidation branch.** The point of
  `v2-consolidation` is that it is small enough to review.