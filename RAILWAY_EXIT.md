# ChampBeam Railway exit: cutover runbook (Cloudflare Worker target)

Single runbook for moving `share.lakeb2b.com` from Railway to the `champbeam` Worker and then retiring the
Railway production services. Written 22 Nov 2026 from read-only probes of Railway, D1 and R2 (evidence below).

**Supersedes.** `deploy/DNS_RUNBOOK.md` sections 1 and 2 (the Coolify origin `64.227.154.215`, `deepify-add-domain.sh`,
the Coolify env flip, the TRUNCATE resync and the service-identity re-provision) and `PRODUCTION_CUTOVER.md`
sections A to C (VPS Compose stack, VPS R2 vars, `pg_dump | pg_restore` into Compose Postgres). Sections 3 of
DNS_RUNBOOK.md (Cloudflare for SaaS for customer domains) and D to H of PRODUCTION_CUTOVER.md (Clerk) are not
covered here and are not changed. Both files carry a pointer to this one. `CLOUDFLARE_DEPLOY.md` section 4 (data move)
is replaced by step 5 below: it empties D1 first, which is wrong now that the Worker holds live data.

Where the files live: the Worker is `worker/` in `main`. A local `cbw/` folder in `~/repos/ChampBeam` is a stale
worktree of an older branch, not a path in `main`, so this file sits at the repo root next to the other two docs.

## 1. What is true today (22 Nov, read only)

| Fact | Evidence |
|---|---|
| `share.lakeb2b.com` is served by Railway | `/health` returns `x-railway-request-id`, `x-railway-edge`, behind the IT-owned Cloudflare zone |
| `champbeam.com` and `www` are served by the Worker | `/health` returns `server: cloudflare` and `cf-ray`, no `x-railway*` |
| The Worker holds a **superset** of Railway's rows | `railway_resync.py --target production` (plan, no writes): 0 Railway rows missing in D1, 0 counter bumps. D1 has rows Railway never saw: users 50 vs 48, file_assets 711 vs 655, click_events 5,493 vs 5,048, page_engagements 10,439 vs 9,624 |
| Six Clerk placeholder users were merged on the Worker side | 484 rows (file_assets 282, link_clicks 194, projects 7, domains 1) are owned by a real user in D1 and by the placeholder in Railway. The script re-owns any new Railway row the same way |
| Blobs | GridFS 535 files, 1,982,762,985 B. Prod R2 `champbeam-files` 589 objects, 2,098,337,158 B, of which 55 are Worker-only. 1 GridFS file is missing in R2: 22,753 B, uploaded 19 Oct, key `u/c73382d7-.../caa1572c-.../dyuthi-plan-pi`, not referenced by any D1 row |
| Railway traffic is near zero | 3 days of HTTP logs (19 to 22 Nov, 5,000 lines): 65 `/r` and `/f` hits, the rest are health probes (`champ-health`, `champ-factory-ops` from `64.227.154.215`) and scanners. No API-key traffic |
| No service identity exists on either side | `service+champ-workspace@championsmail.com` is not in Railway `users` or prod D1, and the Worker has no `SERVICE_API_KEYS` secret (`src/auth/serviceAuth.ts:83` rejects with 401 when unprovisioned). The old re-provision step is moot. If the agent-workspace integration is wanted it is a separate job |
| Prod Worker is behind `main` | Last prod deploy 12 Nov 23:09 UTC. Prod D1 is at migration 0008 and has no `admin_audit` table. `main` and staging are at 0009 |

Headers captured 22 Nov 00:55 UTC:

```
$ curl -sS -o /dev/null -m 15 -D - https://share.lakeb2b.com/health
HTTP/2 200
server: cloudflare
vary: Origin
x-railway-request-id: KxcFBbyvSS6XXqrS0_TJvA
x-hikari-trace: lax1.e74w
x-railway-edge: lax1
cf-cache-status: DYNAMIC
cf-ray: a5e3f82b188da347-SEA

$ curl -sS -o /dev/null -m 15 -D - https://champbeam.com/health
HTTP/2 200
server: cloudflare
cf-ray: a5e3f84088b7ef0c-PDX
```

## 2. The resync is additive, never TRUNCATE

`worker/scripts/railway_resync.py` (reuses `export_postgres_to_d1.py` for the column map and SQL literals):

* Rows: inserts Railway rows whose primary key is missing in D1 (`INSERT OR IGNORE`), raises
  `file_assets.view_count`, `link_clicks.click_count` and `unique_clicks` plus their `last_*_at` when Railway's value is higher,
  and re-owns new rows from a merged placeholder user to the real user. Nothing already in D1 is updated, deleted or
  truncated, so `api_keys` and any identity survive.
* Blobs: copies GridFS files that are missing in R2 or have another size, checks the R2 etag against the md5 it computed.
* Reads Railway through `railway ssh` and the containers' own environment. Neither database has a public TCP proxy
  today, so no host, port or password is read, printed or stored. Needs only `railway` and `wrangler` logged in.
* Default is a read-only plan. `--apply` writes. `--target production` needs `--confirm-production`.
* Shortcut with a known limit: counters are max-wins. A hit counted on both sides in the same window counts once.
* Safe to run twice. The second run reports 0 new rows and 0 files to copy.
* `--undo report.json` removes what an `--apply` added. Staging only.

## 3. Roles

| Who | Does |
|---|---|
| **Deep** | Sends the DNS draft to IT (t_ee370ee8). Dashboard sitting: creates the API token (four permissions, see step 5a), enables Custom Hostnames and reads the live TXT and DCV CNAME of the existing custom hostname `share.lakeb2b.com` (t_7d356d6c). Deep never adds the hostname: it already exists (step 5c). Approves the cutover start and each Railway delete. |
| **IT** | Adds the ownership TXT and the `_acme-challenge` CNAME in the `lakeb2b.com` zone. At cutover, repoints `share.lakeb2b.com` to the target in the draft. Restores the old record on rollback. |
| **Agent** | Everything else: preflight, Worker vars deploy, resync, header and link checks, the seven day watch, the final dump, the deletes after Deep's OK. |

## 4. Gates before the window opens

1. **G1** t_ee370ee8: Deep sent the DNS draft, IT added the TXT and the CNAME. Check from anywhere:
   `dig +short TXT _cf-custom-hostname.share.lakeb2b.com @1.1.1.1` and `dig +short CNAME _acme-challenge.share.lakeb2b.com @1.1.1.1` are both non-empty.
2. **G2** t_7d356d6c: the Worker answers for `share.lakeb2b.com` at the Cloudflare edge. All three readbacks of steps 5a, 5b and 5c must pass
   (fallback origin active, both Worker routes present, custom hostname and its SSL active), plus the pre-flip probe of `customers.champbeam.com/health` in step 5d. A pending hostname alone is not enough.
   The hostname already exists (step 5c). It is never added again and never deleted and re-added: that rotates the TXT IT already holds.
3. **G3** the production Worker runs current `main` and D1 is at migration 0009. Migrations first, then deploy:
   `cd worker && npx wrangler d1 migrations apply champbeam --remote && VITE_GOOGLE_CLIENT_ID=<id> npm run deploy`. This deploys more than vars,
   so it needs Deep's OK of its own. Do it days before, not inside the window.
4. **G4** the safety snapshot of card t_f4caa508 exists (R2 `champ-backups/railway/champbeam/production/Postgres/20261122/` and `.../MongoDB/20261122/`,
   sha256 of the reassembled Mongo archive `20722b37ef99c2434122602cb247069874ea9f1ee156d05bed385007f8f7ff70`).

## 5. Cutover order

Every command runs from the repo root. `$R` is the report directory, for example `~/.hermes/cache/scratch/b1-cutover`.

| # | Who | Step | Command or action | Pass condition |
|---|---|---|---|---|
| 1 | Agent | Preflight plan, read only | `python3 worker/scripts/railway_resync.py --target production --report $R/plan.json` | exit 0, tables show `railway_keys_missing_in_target_after` per table, blobs list what would be copied |
| 2 | Agent | Record the rollback value | `dig +short CNAME share.lakeb2b.com @1.1.1.1; dig +short A share.lakeb2b.com @1.1.1.1` into `$R/before-dns.txt`. Ask IT to note the record they will edit | file exists, IT has noted the old value |
| 3 | Agent | Fresh final dump to R2 | see section 7, step F. Runs before any flip so the dump is the pre-cutover state | manifest in R2 with sha256 that matches a re-download |
| 4 | Agent | Worker recognises the host (recognition only, no minting change) | edit `worker/wrangler.jsonc` top-level `vars.PLATFORM_REDIRECT_HOST` to `"champbeam.com,www.champbeam.com,champbeam.deep-ae0.workers.dev,share.lakeb2b.com,champutm-production.up.railway.app"`, then `cd worker && npm run deploy`. `share.lakeb2b.com` is not first, so nothing mints on it yet. Keep it out of `SHARE_ORIGIN_HOSTS`: that would hide `/api/v1` on the host | `curl -sS https://champbeam.com/health` still 200. Worker test `shareHostCutover.test.ts` (test 2) proves the host is served with this var |
| 5 | Agent | Final resync, pass 1 | `python3 worker/scripts/railway_resync.py --target production --confirm-production --apply --report $R/resync1.json` | exit 0 and `all_railway_data_present_in_target: true` |
| 6 | IT | Flip `share.lakeb2b.com`, only after G2 (steps 5a to 5d) passed | Replace the current record with exactly: `share` CNAME `customers.champbeam.com`, TTL auto. Proxy status: **DNS only (grey cloud)** preferred, the standard Cloudflare for SaaS shape, and the custom hostname route of 5b fires. Proxied (orange cloud) also works because 5b adds the target hostname route. The step 2 mail to IT must carry this record verbatim, since the staged draft (t_20dfca16) only says step 2 is a one line change. Record the time | Grey cloud: `dig +short CNAME share.lakeb2b.com @1.1.1.1` shows `customers.champbeam.com.`. Orange cloud: **no dig proof exists**. The CNAME query prints nothing and the A query returns Cloudflare IPs both before and after the flip, so dig cannot tell the two apart. Step 7's headers are the proof |
| 7 | Agent | Verify the host is on the Worker | `curl -sS -o /dev/null -m 15 -D - https://share.lakeb2b.com/health` must show `cf-ray` and **no** `x-railway*`. Then 5 old links: `/r/<short_code>` returns 302 to the stored URL, `/f/<short_code>` returns 200. Pick codes with `SELECT short_code FROM link_clicks ORDER BY created_at LIMIT 5` and the same on `file_assets` against D1 | no `x-railway` header, all 10 probes pass |
| 8 | Agent | Final resync, pass 2, 10 minutes after the flip | same command as step 5, report `$R/resync2.json` | exit 0, picks up Railway writes between pass 1 and the flip |
| 9 | Agent | Start minting on the share host | in `worker/wrangler.jsonc` set `PLATFORM_REDIRECT_HOST` to `"share.lakeb2b.com,champbeam.com,www.champbeam.com,champbeam.deep-ae0.workers.dev,champutm-production.up.railway.app"` and `REDIRECT_BASE_URL` to `"https://share.lakeb2b.com"`, then `cd worker && npm run deploy`. Reset mail links stay on `champbeam.com`: they come from `BETTER_AUTH_URL` (`worker/src/auth/betterAuth.ts:54`), not from these two vars | an API-key `POST /api/v1/utm/generate` returns `redirect_url` on `https://share.lakeb2b.com/r/...`. Test `mints links and file URLs on share.lakeb2b.com` |
| 10 | Agent | Start the 7 day watch | log the header once a day (section 7, step A). Do not delete or redeploy anything on Railway | log file grows daily |

### Steps 5a to 5d: make the Worker answer for the host at the edge (before IT flips)

Without these the flip lands on a host no Worker owns. On 22 Nov the champbeam.com zone had 0 Worker routes and `custom_hostnames/fallback_origin`
returned 403. They are agent steps, done with the token Deep creates in t_7d356d6c. The token needs **four** permissions on zone champbeam.com:
Zone Read, DNS Edit, SSL and Certificates Edit, and **Workers Routes Edit** (the card lists the first three, add the fourth when creating it).
Saved at `~/.hermes/secrets/cf-champbeam-token`, read in-process, never echoed. Shared setup for 5a to 5d:

```
CF=$(cat ~/.hermes/secrets/cf-champbeam-token)
api() { curl -sS -m 20 -H "Authorization: Bearer $CF" -H 'Content-Type: application/json' "$@"; }
Z=$(api "https://api.cloudflare.com/client/v4/zones?name=champbeam.com" | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"][0]["id"])')
```

| # | Who | Step | Command | Readback pass condition |
|---|---|---|---|---|
| 5a | Agent | Fallback origin: a proxied placeholder record, then register it | `api -X POST https://api.cloudflare.com/client/v4/zones/$Z/dns_records -d '{"type":"AAAA","name":"customers.champbeam.com","content":"100::","proxied":true}'` then `api -X PUT https://api.cloudflare.com/client/v4/zones/$Z/custom_hostnames/fallback_origin -d '{"origin":"customers.champbeam.com"}'` | `api https://api.cloudflare.com/client/v4/zones/$Z/custom_hostnames/fallback_origin` shows `"origin":"customers.champbeam.com"` and `"status":"active"` (it starts `pending_deployment`: poll every 30 s, up to 10 min). The record IT flips to is `customers.champbeam.com` (written out in step 6): the step 2 mail to IT must carry it |
| 5b | Agent | Two Worker routes for the SaaS host, so either proxy state of IT's record reaches the Worker. Cloudflare's O2O table (https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/hostname-routing/): a custom hostname route fires only for a grey cloud record, a target hostname route only for an orange cloud record. Not `*/*`: it would sweep the rest of champbeam.com. Done by API on purpose: it only adds routes, while a `routes` block in `worker/wrangler.jsonc` would make the next `wrangler deploy` manage the production domains too | `for H in customers.champbeam.com share.lakeb2b.com; do api -X POST https://api.cloudflare.com/client/v4/zones/$Z/workers/routes -d "{\"pattern\":\"$H/*\",\"script\":\"champbeam\"}"; done` | `api https://api.cloudflare.com/client/v4/zones/$Z/workers/routes` lists **both** entries, `"pattern":"customers.champbeam.com/*"` and `"pattern":"share.lakeb2b.com/*"`, each with `"script":"champbeam"`. Dashboard fallback: Workers and Pages, champbeam, Settings, Domains and Routes, Add route, zone champbeam.com, once per pattern |
| 5c | Agent. Deep only if the hostname is gone | The custom hostname `share.lakeb2b.com` already exists. Recorded on the board, not a live read: id `edf15e0b-c058-4edf-8035-9fae048a28eb`, created 10 Nov (t_5123f6d3), measured 20 Nov as status `moved`, ssl `pending_validation`, error "zone does not have a fallback origin set" (t_1e60332a). Cloudflare deletes a hostname after 7 days in Moved, so the deadline is 27 Nov at the latest, earlier if it moved before 20 Nov. A re-add issues a new TXT, which would void the IT draft. Steps: (a) GET by hostname. (b) Present: **never add it**. If `moved`, PATCH to restart validation after 5a, with the same `ssl` method and type as the original request ([Validation status](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/domain-support/hostname-validation/validation-status), [Troubleshooting](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/reference/troubleshooting)). (c) Compare the values with the IT draft (t_ee370ee8). (d) Gone: **stop**. The draft values are stale, Deep decides, and the draft is refreshed before he sends anything. The agent does not re-add | `api "https://api.cloudflare.com/client/v4/zones/$Z/custom_hostnames?hostname=share.lakeb2b.com"`, then only when `"status":"moved"`: `api -X PATCH https://api.cloudflare.com/client/v4/zones/$Z/custom_hostnames/edf15e0b-c058-4edf-8035-9fae048a28eb -d '{"ssl":{"method":"txt","type":"dv"}}'`, then GET again | The list returns exactly one hostname, with the id above. `ownership_verification.value` equals the TXT in the IT draft (`6c99aee2-...`) and the DCV CNAME target equals the draft's (`share.lakeb2b.com.377959ca637fd1f5.dcv.cloudflare.com`). After IT's records are in: `"status":"active"` and `"ssl":{"status":"active"`, no `verification_errors`. Zero results means gone: stop. If the token still gets 403 here, Deep reads the same values in the dashboard and pastes them to the card |
| 5d | Agent | Probe the CNAME target before the DNS flip. Probing `share.lakeb2b.com` itself cannot pass yet: while IT's zone owns the name, `--resolve` to any Cloudflare IP reaches the lakeb2b.com zone and returns Railway (seen 22 Nov, `x-railway-edge: sjc1`). `/health` does not depend on the host (`worker/src/app.ts:67`, `src/lib/shareOrigin.ts:16`), so this proves the fallback record and route 5b reach the Worker | `curl -sS -o /dev/null -m 15 -D - https://customers.champbeam.com/health` | `HTTP/2 200`, `cf-ray` present, **no** `x-railway*`. A 5xx, 404 or 522 means the record or the route is wrong: stop, IT does not flip. Step 7 is the first proof on `share.lakeb2b.com` itself |

Rollback of 5a to 5c: `DELETE` both routes (`/workers/routes/<id>`) and the DNS record. They are additive and unused until the flip. Do not delete and re-add
the hostname once IT holds the TXT: that rotates it.
Not run yet: 5a to 5d need the token (none exists on 22 Nov), and 5c needs the hostname, which the board records but nobody has read live. The command shapes follow the Cloudflare API and are
unproven until the sitting.

Order matters in two places. Step 4 comes before the flip, otherwise the host is unknown to the Worker and every old link
redirects to `/` (test `is refused while the host is not in PLATFORM_REDIRECT_HOST`). Step 9 comes after the flip, otherwise
new links would point at a host that still serves Railway.

### Window length

Measured 22 Nov against staging (section 8). Full load into an empty target: 23.9 minutes (rows 54 s, blobs 22.9 minutes, 1.98 GB at
about 1.4 MB/s through `railway ssh`). The re-run that picked up the 80 files that failed on a token expiry and rate limits took 2.6 minutes. A re-run
with nothing left to copy took 1.2 minutes (71 s: 58 s of it is the read of Postgres and D1, 13 s the file listings). Production is already in sync (preflight plan: 1 file of 22,753 B
to copy, 0 rows), so one pass is about 1.5 to 2 minutes and the window is two passes plus the DNS change. Budget 30 minutes from step 5 to step 8.
Two limits found while measuring, both handled in the script: Railway allows only a few concurrent `ssh` sessions to a service and
cuts a session whose command line carries 30 or more ids, so file ids go in batches of 12 over 3 lanes.

## 6. Rollback

| When | Action | Data |
|---|---|---|
| Before step 6 | Nothing to undo. Steps 4 and 5 only add. Revert the `wrangler.jsonc` var change if wanted | none lost |
| After step 6, before step 9 | IT restores the record noted in step 2. Railway is still running and holds every row it had | Rows the Worker wrote since the flip (new clicks, new files) are not on Railway. There is no Worker to Railway sync. Accepted: Railway took about 65 link hits in 3 days |
| After step 9 | IT restores the record, and revert `REDIRECT_BASE_URL` and the host order, redeploy | Links minted on `share.lakeb2b.com` since step 9 stop resolving until the host returns |
| After the retire | No rollback to Railway. Restore from R2 `champ-backups/railway/champbeam/production/` with `pg_restore` and `mongorestore` into a new service | |

## 7. Retire checklist (after the flip)

Nothing here is deleted until **all three** hold. Each delete also needs Deep's OK, named per service.

* **(a)** 7 days of the header absent. Run once a day from step 10 (cron or by hand). It fails closed: a timeout, a DNS error or a non 200 is a bad day, never a clean one.
  ```
  H=$(curl -sS -o /dev/null -m 15 -D - https://share.lakeb2b.com/health || true)
  S=$(printf '%s' "$H" | head -1 | tr -d '\r' | awk '{print $2}')
  RAY=$(printf '%s' "$H" | grep -ci '^cf-ray'); RW=$(printf '%s' "$H" | grep -ci '^x-railway')
  if [ "$S" = 200 ] && [ "$RAY" -ge 1 ] && [ "$RW" = 0 ]; then V=GOOD; else V=BAD; fi
  echo "$(date -u +%FT%TZ) status=${S:-none} cf-ray=$RAY x-railway=$RW $V" >> $R/header-watch.log
  ```
  A day is GOOD only with status 200, `cf-ray` present and `x-railway` absent. A Railway response carries two `x-railway*` lines
  (`x-railway-request-id`, `x-railway-edge`), so a bad day shows `x-railway=2`, not 1. The gate holds when 7 consecutive UTC dates after the flip each have a
  GOOD line and no BAD line. Any BAD line, or a date with no line, restarts the count. Checked 22 Nov: share.lakeb2b.com logs `status=200 cf-ray=1 x-railway=2 BAD`,
  champbeam.com logs `GOOD`, an unresolvable host logs `status=none cf-ray=0 x-railway=0 BAD`.
* **(b)** the W2 snapshot (t_f4caa508) plus a fresh final dump in R2 `champ-backups/railway/champbeam/production/`. Step F:
  ```
  railway link --project ChampBeam --environment production   # once; `railway ssh --project` wants an id, not the name
  D=$(date +%Y%m%d)
  railway ssh --service Postgres -- 'unset PGHOST; pg_dump -U $POSTGRES_USER -d $POSTGRES_DB -Fc --no-owner' > Postgres.dump
  railway ssh --service MongoDB -- 'mongodump --uri "$MONGO_URL" --archive --gzip' > MongoDB.archive.gz
  split -b 262144000 MongoDB.archive.gz MongoDB.archive.gz.part-
  # each file: wrangler r2 object put champ-backups/railway/champbeam/production/<Service>/$D/<file> --remote --file <file>
  # manifest.json beside them with bytes + sha256 per part; re-download one part and compare sha256
  ```
  The pg_dump line was run on 22 Nov: 931,000 B, 32 tables, as in the W2 manifest. The mongodump line was started on 22 Nov and streamed its first 1,000 bytes; the full 1.8 GB run is the W2 job and was not repeated here.
  Do both dumps before the flip (step 3) and again just before the first delete. Delete the local files afterwards.
* **(c)** Deep's OK, per delete.

Also before the first delete, run `python3 worker/scripts/railway_resync.py --target production --confirm-production --skip-rows`
(blobs plan). It must report `copied_files: 0` and `gridfs_names_present_in_r2_with_same_size` equal to `gridfs_files`.

Delete order (project ChampBeam, environment `production` only; the Testing environment is decided on t_989c8094, not here):

1. **ChampBeam Backend**, both branch pins (`v2-consolidation`, `main`). First, so nothing can write while the data services go.
   `railway service delete --environment production --service "ChampBeam Backend" --yes` (after the `railway link` above)
2. **MongoDB**, after the blob check above. `railway service delete --environment production --service MongoDB --yes`
3. **Postgres**, after a row-count compare of the fresh dump against D1 (script `--target production` plan shows `railway_keys_missing_in_target_after: 0` for every table). `railway service delete --environment production --service Postgres --yes`
4. `railway volume list --environment production` must show no volume left. Delete any orphan with `railway volume delete`.
5. Leave the project and the Testing environment alone until t_989c8094 is decided.

Before step 1, also move what still points at Railway: the monitor `champ-factory-ops` probes
`https://champutm-production.up.railway.app/health` (103 hits in 3 days) and will alarm when that host dies. Links already shared on
`champutm-production.up.railway.app` stop resolving then. The Worker keeps that host in `PLATFORM_REDIRECT_HOST`, which is harmless.

## 8. Staging dry-run

Run against `champbeam-staging` and `champbeam-files-staging` only, results in the PR description.
Staging is not allowed customer data (`worker/wrangler.jsonc` rules), so everything the run added was removed again with
`--undo`, and the staging counts after the undo equal the counts before the run (the PR shows both). While the data was
in, `https://staging.champbeam.com/f/<code>/<name>` served six migrated files with the exact stored sizes, including five
whose key contains `..`.

## 9. Open items this runbook does not decide

* **Who runs 5a to 5c: t_1e60332a** (p140, todo, assignee default, parent t_43f209c8). It owns the same fallback origin, Worker route and the IT email refresh, so this runbook is its checklist for those steps and it must not invent a second set of values. Two differences to settle there: it expects the fallback hostname `origin.champbeam.com` (and PR #60's `setup_saas.mjs` creates `origin.champbeam.com` plus `cname.champbeam.com`), while this runbook uses `customers.champbeam.com`. The name is arbitrary but the IT mail names it, so t_1e60332a picks one and the step 6 record and the 5b patterns follow it. And PR #60 adds a top level `*/*` route on champbeam.com in `worker/wrangler.jsonc`, which would sweep the whole zone: that conflicts with 5b and must not ride along.
* **PR #60 and #67 are not needed for the cutover.** Old links and files are rows with `domain_id NULL`. A host listed in `PLATFORM_REDIRECT_HOST` is a platform host (`worker/src/env.ts:216` `isPlatformHost`), and a platform host is served from those rows (`worker/src/services/assetLookup.ts:28` returns no domain, `worker/src/routes/redirect.ts:84` refuses only non platform hosts without a domain). `shareHostCutover.test.ts` test 2 proves `/health`, `/r`, `/s` and `/f` on Host `share.lakeb2b.com` with that one var, and test 1 proves production today refuses it. What #60 adds is a different path: Deep adds the host in Settings as an org custom domain, then adoption moves the `NULL` rows onto it (`services/orgAdoption.ts`), plus the DNS records UI (#67). Needed only if the host should become an org domain, and #60's own text says `share.lakeb2b.com` stays out of `PLATFORM_REDIRECT_HOST`, so the two models are alternatives, not steps of one cutover. This runbook uses the platform host model. Do not mix them without a decision.
* G3 above is a deploy of `main` to production. It needs Deep's OK and is not part of this card.
* The sitting t_7d356d6c only gives the agent a token and enables Custom Hostnames. The fallback origin, the two Worker routes and the active-hostname check are agent steps 5a to 5c here,
  and 5d proves the edge through `customers.champbeam.com` before the flip. None of 5a to 5d has run: no token exists yet and the hostname state is the recorded one of 20 Nov. The Host-header proof (`shareHostCutover.test.ts`) is at the Worker, not at the Cloudflare edge.
* `SERVICE_API_KEYS` and the `service+champ-workspace@championsmail.com` identity are absent on both sides. Provisioning them is separate.
