# ChampUTM Production Cutover Checklist

Single source of truth for taking ChampUTM to production on `main`. Work top to bottom;
the order matters (especially the domain section). Check each box as you go.

## Where things live
- **Backend** (FastAPI: API + short links `/r/...` + files `/f/...`): Railway service. Env vars + the Mongo plugin go here.
- **Frontend app UI**: Vercel. Env vars go in Project Settings -> Environment Variables.
- **Short links / files / API host**: the backend, served on `share.lakeb2b.com`.
- **DNS**: Cloudflare (the `lakeb2b.com` zone).
- **Auth**: Clerk.

CLI note: install the Railway CLI and run `railway link` once to select the project, environment
(production), and the backend service before the `railway ...` commands below. Reference variables
like `${{MongoDB.MONGO_URL}}` are easiest to set in the dashboard (the shell tries to expand `${{...}}`).

---

## A. MongoDB file storage (survives redeploys)
The GridFS backend is already built and tested; this just turns it on.

- [ ] **Add the MongoDB plugin** (dashboard only, plugins cannot be added by token)
  - Dashboard: backend project -> **New -> Database -> Add MongoDB**.
- [ ] **Point storage at Mongo** (backend service -> Variables)
  - `STORAGE_BACKEND=mongo`
  - `MONGO_URL=${{MongoDB.MONGO_URL}}` (reference the plugin; prefer its private URL if shown)
  - `STORAGE_UPLOAD_SECRET=<long random string>` (gates the blob-upload endpoint)
  - optional: `MONGO_DB=champutm_files`, `MONGO_BUCKET=fs`
  - CLI (literal URL variant): `railway variables --set STORAGE_BACKEND=mongo --set 'MONGO_URL=<paste connection string>' --set STORAGE_UPLOAD_SECRET=<random>`
- [ ] **Redeploy** (dashboard: Deploy; CLI: `railway redeploy`)
- [ ] **Verify** (see F1)

## B. Base domain `share.lakeb2b.com` (DO IN ORDER)
Avoid the "shows Live but won't connect" trap: do NOT set `REDIRECT_BASE_URL` until step B3 passes.

- [ ] **B1. Add the custom domain on Railway** (dashboard only; token returns Unauthorized for this)
  - Dashboard: backend service -> **Settings -> Networking -> Custom Domain** -> add `share.lakeb2b.com`.
  - Railway shows a **CNAME target** (something like `xxxx.up.railway.app`). Copy it.
- [ ] **B2. Add the DNS record in Cloudflare**
  - `share` **CNAME** -> the Railway target from B1, **DNS only (grey cloud)** so Railway issues the TLS cert.
- [ ] **B3. Wait until it actually routes** (do not skip)
  - Railway shows the domain as active/issued, and `curl https://share.lakeb2b.com/health` returns `{"status":"healthy"}`.
- [ ] **B4. Flip the base URL** (only after B3)
  - Variable: `REDIRECT_BASE_URL=https://share.lakeb2b.com` (CLI: `railway variables --set REDIRECT_BASE_URL=https://share.lakeb2b.com`), then redeploy.
  - `PLATFORM_REDIRECT_HOST` is derived from this; no need to set it separately.
- [ ] **Verify** (see F2)

## C. Clerk: development -> production
- [ ] **C1.** In the Clerk dashboard, create/promote the **production instance** and set the app's production domain.
- [ ] **C2.** Add Clerk's required **DNS records** (on the frontend domain) and wait for Clerk to verify them.
- [ ] **C3.** Backend (Railway): `CLERK_SECRET_KEY=sk_live_...`
- [ ] **C4.** Frontend (Vercel): `VITE_CLERK_PUBLISHABLE_KEY=pk_live_...`, then redeploy the frontend.
- [ ] **Verify** (see F3)

## D. Frontend + CORS
- [ ] **D1. Vercel env**
  - `VITE_API_URL=https://share.lakeb2b.com` (the API and short links share the backend host)
  - `VITE_CLERK_PUBLISHABLE_KEY=pk_live_...` (from C4)
- [ ] **D2. Backend CORS** (Railway): `FRONTEND_URL=https://<your-vercel-prod-origin>`
  - The hardcoded `champ-utm.vercel.app` + Vercel preview regex in `backend/app/main.py` stay as harmless fallbacks.
  - If you later add a custom app domain (e.g. `app.lakeb2b.com`), add it via `CORS_ALLOW_ORIGINS=https://app.lakeb2b.com`.
- [ ] **Verify** (see F4)

## E. Delete Resend variables (safe)
No backend code references Resend, and `Settings(extra="ignore")` means removing them cannot break startup.
- [ ] Delete `RESEND_API_KEY` and any other `RESEND_*` vars from the Railway backend service.
- [ ] (Already done in code) the stale README "Account Security" bullets were updated to reflect Clerk.

---

## F. Verification probes
Run the matching probe right after each section.

- **F1 (Mongo):**
  ```bash
  curl -s -X POST https://share.lakeb2b.com/api/v1/files \
    -H 'Content-Type: application/json' \
    -d '{"filename":"x.pdf","content_type":"application/pdf","size_bytes":100}'
  # expect 201 with a presigned_put_url containing /blob?token=
  ```
  Then upload via the app, open the `/f/{code}` URL, and confirm the read receipt flips to "Opened".
  Optional: the Mongo plugin's `champutm_files.fs.files` collection has a document.
- **F2 (domain):**
  ```bash
  curl -s https://share.lakeb2b.com/health          # {"status":"healthy"}
  ```
  Generate a link in the app -> the short URL is on `share.lakeb2b.com`; opening `/r/{code}` redirects,
  and `/f/{code}` serves a file.
- **F3 (Clerk prod):** sign in on the production frontend with the `pk_live` key; an authed call
  (e.g. open Settings -> Domains, which calls `/api/v1/domains`) returns data, not 401.
- **F4 (CORS):**
  ```bash
  curl -s -i -X OPTIONS https://share.lakeb2b.com/api/v1/utm/generate \
    -H 'Origin: https://<your-vercel-prod-origin>' \
    -H 'Access-Control-Request-Method: POST' | grep -i access-control-allow-origin
  # expect the Access-Control-Allow-Origin header echoing your origin
  ```

## Later / optional (already built, env-gated, not required for launch)
- **Platform subdomains** (`acme.lakeb2b.com`): set `PLATFORM_SUBDOMAIN_BASE` after a wildcard
  DNS + cert is live. See the Custom Domains section in `README.md`.
- **Bring-your-own-domain** (`track.customer.com`): set `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ZONE_ID`,
  `CLOUDFLARE_CNAME_TARGET` once Cloudflare for SaaS is enabled on a zone. No backend code changes needed.
