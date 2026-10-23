# Porting guide: FastAPI (backend/) -> Cloudflare Worker (worker/)

The Worker must be a **drop-in replacement** for the Python API: same paths,
methods, status codes, JSON field names and error bodies. The React SPA
(`frontend/`) is not being changed, so any response-shape drift is a bug.

## Stack
- **Hono** routers (`src/routes/*.ts`), one per Python router, already mounted
  in `src/app.ts` at the same prefix. Fill in the stub; don't change mounts.
- **D1 via Drizzle**: `c.var.db` (`src/db/client.ts`), schema in
  `src/db/schema.ts` (camelCase TS props, snake_case columns identical to
  Postgres). DDL is `migrations/0001_init.sql`. Raw SQL is fine:
  `` db.all(sql`...`) `` / `c.env.DB.prepare(...)`.
- **R2** via `src/lib/storage.ts` (same function names as storage.py).
- Settings: `c.var.settings` (`src/env.ts`), camelCase of config.py fields.

## Translation table
| Python | Worker |
|---|---|
| `Depends(require_auth)` etc. | `await requireAuth(c)` … (`src/auth/security.ts`) |
| `TokenData.user_id / org_id / is_org_admin` | `user.userId / user.orgId / isOrgAdmin(user)` |
| `raise HTTPException(s, detail)` | `httpError(s, detail)` (`src/lib/errors.ts`) |
| Pydantic body model | zod schema + `await parseJson(c, Schema)` (`src/lib/validate.ts`) |
| `Query(default, ge, le)` | `parseQuery(c, z.object({ days: qInt(30, {ge:1, le:365}) }))` |
| `UUID` path param | `uuidParam(c, "file_id")` (422 on bad UUID, like FastAPI) |
| `BackgroundTasks.add_task(f)` | `background(c, () => f())` (`src/lib/background.ts`) |
| `redis_client.incr_with_ttl` | `incrWithTtl(c.env.DB, key, ttl)` / `enforceLimit` (`src/lib/ratelimit.ts`) |
| `datetime.utcnow()` | `nowIso()` (`src/lib/time.ts`) |
| `iso_utc(dt)` in a response | `isoUtc(v)` ("...Z") |
| Pydantic `datetime` field in a response | `isoNaive(v)` (no "Z", exactly like Pydantic) |
| `date_trunc('day', col)` | `substr(col, 1, 10)` (stored format is ISO text) |
| `func.date_trunc('hour', col)` | `substr(col, 1, 13) \|\| ':00:00'` |
| `col.ilike(x)` | `lower(col) LIKE lower(x)` |
| `uuid4()` | `crypto.randomUUID()` |
| `hashlib.sha256 / hmac / secrets.*` | `src/lib/crypto.ts` (same outputs) |
| `request.client.host` / X-Forwarded-For | `clientIp(c)` (`src/lib/request.ts`, CF-Connecting-IP first) |
| MaxMind `.mmdb` City/ASN lookups | `cfGeo(c)` — Cloudflare's `request.cf` (country, region, city, lat/lon, asn, asOrganization) |
| `request.headers["host"]` | `requestHost(c)`; `request.base_url` -> `requestOrigin(c)` |
| `session.commit()` after several writes | `db.batch([...])` when atomicity matters (no interactive transactions on D1) |
| `IntegrityError` | `isUniqueViolation(err)` (`src/db/client.ts`) |
| `HTMLResponse` / `RedirectResponse(url, 302/307)` | `c.html(...)` / `c.redirect(url, 302)` — keep the Python status code |
| `StreamingResponse` from storage | `new Response(obj.body, { headers })` with Range support via `getObject(bucket, key, { range: c.req.raw.headers })` |

## Rules
1. **Behaviour parity first.** Read the Python file end to end before writing.
   Keep every endpoint, status code, header, cookie, `detail` string and
   response key. Keep comments that explain *why* (trim the Python-specific ones).
2. **Response JSON**: use the exact snake_case keys the Python returned. UUIDs
   are plain strings. Booleans are real booleans (Drizzle maps 0/1 for you;
   raw SQL returns 0/1 — convert with `!!`). JSON columns come back parsed via
   Drizzle `mode: "json"`; in raw SQL use `JSON.parse`.
3. **D1 limits**: ≤100 bound params per statement — chunk large `IN` lists with
   `chunk()`; no `BEGIN/COMMIT`.
4. **Timestamps** are stored with `nowIso()` / `toStored()` only, never another
   format, so text comparison stays correct.
5. **Don't edit shared core** (`src/app.ts`, `src/env.ts`, `src/auth/*`,
   `src/lib/*`, `src/db/*`, `migrations/*`, `test/helpers.ts`,
   `test/setup.ts`). If you truly need a change there, make the smallest
   additive change and say so in your final report.
6. Stay inside the files you own (listed in your task). Other agents are
   editing other files at the same time.
7. **Tests**: port the matching `backend/tests/test_*.py` cases to
   `test/<area>.test.ts` (Vitest, see `test/core.test.ts` and
   `test/helpers.ts`). Each Python test should have a TS counterpart unless it
   tests something that no longer exists (say which, and why, in your report).
8. Before finishing: `npx tsc --noEmit` and `npx vitest run test/<your files>`
   must pass. Leave no `TODO(port)` in your files.
9. Things that genuinely cannot work on Cloudflare: implement the closest
   equivalent and record it in your final report under "Deviations".

## Running
```
cd worker
npx tsc --noEmit
npx vitest run test/<file>.test.ts
```
