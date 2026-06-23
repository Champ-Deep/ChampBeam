# Champbeam Go-Live Checklist

Single source of truth for taking Champbeam to production. The deploy mechanics (the Docker
Compose stack) live in the README "Production, VPS (Docker Compose)" section; this file is the
ordered go-live checklist. Work top to bottom; the domain order matters. Check each box as you go.

## Where things live
- **Backend** (API + short links `/r/...` + files `/f/...`): the DigitalOcean VPS, via the `deploy/` Docker Compose stack (app + Postgres + Redis + Caddy).
- **App UI**: Vercel.
- **Public host**: `champbeam.com` root, served by the VPS; the app UI on `app.champbeam.com` (CNAME to Vercel).
- **DNS**: your champbeam.com DNS provider. **Auth**: Clerk. **Errors**: self-hosted Sentry on the droplet.

---

## A. Deploy the backend on the VPS
Full commands are in README "Production, VPS (Docker Compose)".
- [ ] Droplet has Docker + the Compose plugin; ports 80/443 open.
- [ ] DNS `A` record: `champbeam.com -> <droplet IP>`.
- [ ] `deploy/.env` filled in (from `deploy/.env.example`): strong `POSTGRES_PASSWORD` with a matching `DATABASE_URL`, `CLERK_SECRET_KEY`, R2 vars, `STORAGE_UPLOAD_SECRET`.
- [ ] `cd deploy && docker compose up -d --build`.
- [ ] Verify (P2): `curl https://champbeam.com/health` returns `{"status":"healthy"}` (Caddy issues the cert once DNS resolves).

## B. Durable file storage (Cloudflare R2, recommended)
Keeps file bytes off the droplet disk; the code already supports it (no code change).
- [ ] Create an R2 bucket + an R2 API token (S3 credentials).
- [ ] In `deploy/.env`: `STORAGE_BACKEND=s3`, `SUPABASE_STORAGE_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com`, `SUPABASE_STORAGE_REGION=auto`, `SUPABASE_STORAGE_ACCESS_KEY_ID`, `SUPABASE_STORAGE_SECRET_ACCESS_KEY`, `SUPABASE_STORAGE_BUCKET`, `STORAGE_UPLOAD_SECRET=<long random>`.
  - (the vars are `SUPABASE_`-prefixed for historical reasons; they accept any S3-compatible store, R2 included)
- [ ] `docker compose up -d` to apply, then verify (P1).
- Alternatives: on-droplet `local` disk is durable too (a real disk, not ephemeral), or `mongo` GridFS. The backend logs a startup WARNING only if it boots in production on `local`.

## C. Data migration off Railway (one time, only if keeping existing data)
- [ ] `pg_dump "<railway DATABASE_URL>" --no-owner --no-privileges -Fc -f champbeam.dump`
- [ ] `docker compose cp champbeam.dump postgres:/tmp/champbeam.dump`
- [ ] `docker compose exec postgres pg_restore -U champbeam -d champbeam --no-owner /tmp/champbeam.dump`
- Files in R2 are unaffected; only the Postgres data moves.

## D. Clerk: development -> production
- [ ] Create/promote the Clerk **production instance**; set the production domain.
- [ ] **Rename the Clerk application `Champ UTM` -> `ChampBeam`** (Dashboard ->
      application name / branding). This is what users see on the hosted sign-in
      modal and component cards; it is a dashboard setting, not code.
- [ ] Add Clerk's required DNS records (on the app UI domain) and wait for verification.
- [ ] Backend (`deploy/.env`): `CLERK_SECRET_KEY=sk_live_...` and
      `CLERK_PUBLISHABLE_KEY=pk_live_...` (the latter turns on **issuer
      verification** — the backend derives the expected `iss` from it).
- [ ] (Recommended) `CLERK_AUTHORIZED_PARTIES=https://app.champbeam.com` so only
      tokens minted for the app origin are accepted (`azp` check). Defaults to
      `FRONTEND_URL` when unset.
- [ ] Frontend (Vercel): `VITE_CLERK_PUBLISHABLE_KEY=pk_live_...`, redeploy.
- [ ] Verify (P3).

## D2. Clerk Organizations + webhook (for the team/admin edition)
The org/admin features (shared content library + consolidated analytics) ride on
**Clerk Organizations**; the backend reads `org_id` + role from the session token.
- [ ] Enable **Organizations** in the Clerk Dashboard. Confirm the default roles
      `admin` and `member` exist (the app treats the `admin` role as the
      org admin).
- [ ] Create the marketing org as admin; invite the sales seats as members.
- [ ] Add a **webhook**: Dashboard -> Webhooks -> endpoint
      `https://champbeam.com/api/v1/webhooks/clerk`, subscribe to `user.*`,
      `organization.*`, and `organizationMembership.*`. Put its signing secret in
      `deploy/.env` as `CLERK_WEBHOOK_SECRET=whsec_...`. (Without it, users/orgs
      still sync lazily from the session token on each auth, but membership
      removals won't propagate until the next sign-in.)
- [ ] Verify: an admin sees Team + Library in the nav and `/api/v1/org/context`
      returns `is_admin: true`; a member sees Library but is 403 on
      `/api/v1/org/analytics/content`.

## E. Frontend + CORS
- [ ] Vercel: `VITE_API_URL=https://champbeam.com`, `VITE_CLERK_PUBLISHABLE_KEY=pk_live_...`.
- [ ] Backend (`deploy/.env`): `FRONTEND_URL=https://app.champbeam.com` (the app UI origin).
  - `app.champbeam.com`, `champbeam.com`, and `champbeam*`/`champ-utm*` Vercel hosts are already in the CORS defaults in `backend/app/main.py`; add more via `CORS_ALLOW_ORIGINS`.
- [ ] Verify (P4).

## F. Sentry (handled by the intern)
- [ ] Wire the SDK per README "Error monitoring (Sentry)" and set `SENTRY_DSN` in `deploy/.env`.

## F2. ISP / VPN detection (MaxMind GeoLite2)
Click ISP + VPN/hosting detection uses local MaxMind databases. Without them the
code falls back to ip-api.com, whose free tier **blocks datacenter/VPS IPs** — so
on the droplet VPN/ISP silently stops resolving. Fix:
- [ ] Create a free MaxMind license key (https://www.maxmind.com/en/geolite2/signup).
- [ ] Set `MAXMIND_LICENSE_KEY=...` in `deploy/.env`. On boot the app downloads
      the City + ASN databases into the persisted `geoipdata` volume (one-time).
- [ ] Verify: open a tracked link from a VPN/datacenter IP and confirm the click
      shows the ISP/ASN and the VPN flag in Link analytics.

## G. Delete Resend variables (safe)
No backend code references Resend, and `Settings(extra="ignore")` means removing them cannot break startup.
- [ ] Delete `RESEND_*` vars wherever they still live (the old Railway service / any `.env`).

---

## Verification probes
- **P1 (storage):**
  ```bash
  curl -s -X POST https://champbeam.com/api/v1/files \
    -H 'Content-Type: application/json' \
    -d '{"filename":"x.pdf","content_type":"application/pdf","size_bytes":100}'
  # expect 201 with a blob/presigned upload URL
  ```
  Then upload via the app, open the `/f/{code}` URL, and confirm the read receipt flips to "Opened".
- **P2 (host):** `curl -s https://champbeam.com/health` returns `{"status":"healthy"}`. Generate a link -> short URL on champbeam.com; `/r/{code}` redirects; `/f/{code}` serves.
- **P3 (Clerk prod):** sign in on the production app with the `pk_live` key; an authed call (Settings -> Domains -> `/api/v1/domains`) returns data, not 401.
- **P4 (CORS):**
  ```bash
  curl -s -i -X OPTIONS https://champbeam.com/api/v1/utm/generate \
    -H 'Origin: https://app.champbeam.com' \
    -H 'Access-Control-Request-Method: POST' | grep -i access-control-allow-origin
  ```

## Later / optional (already built, env-gated)
- **Platform subdomains** (`acme.champbeam.com`): set `PLATFORM_SUBDOMAIN_BASE` after a wildcard DNS + cert is live. See README "Custom Domains".
- **Bring-your-own-domain** (`track.customer.com`): set the `CLOUDFLARE_*` vars once Cloudflare for SaaS is enabled. No backend code changes.
- **Domain procurement** (buy a domain in-app): set `CLOUDFLARE_ACCOUNT_ID` (+ a token with Registrar write scope, and optionally `CLOUDFLARE_REGISTRANT_EMAIL`). Turns on the search/check/buy flow in Settings -> Domains. The Cloudflare Registrar API is in **beta** and supports a subset of TLDs; registrations are billed to the account's default payment profile and are non-refundable, so keep this gated until you've confirmed the account is funded and a default registrant contact is set.
