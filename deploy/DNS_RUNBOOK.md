# DNS Runbook — share.lakeb2b.com cutover + custom-domain infrastructure

Status as of 2026-07-23: the ChampBeam backend runs on the DigitalOcean VPS
(`64.227.154.215`, "Deepify"/Coolify, fronted by host nginx + certbot). The
`share.lakeb2b.com` record in Cloudflare still points at the **old Railway
deployment**, so share links minted by the new backend 404 until the record is
repointed. Until then the platform mints links on
`champbeam-api.64.227.154.215.sslip.io` (see "Interim state" below).

## 1. The one change IT makes (Cloudflare, lakeb2b.com zone)

| Record | Type | Value | Proxy status |
|---|---|---|---|
| `share.lakeb2b.com` | A | `64.227.154.215` | **DNS only (grey cloud)** — required initially so Let's Encrypt can issue at the origin |

Replace the existing record (currently a proxied entry targeting Railway).
Old Railway-era share links stop resolving at this moment — expected; that
deployment's database is being retired.

The proxy (orange cloud) can be re-enabled later **after** step 2 confirms the
origin cert exists — set Cloudflare SSL/TLS mode to **Full (strict)** if so.

## 2. What we run after the record flips (already scripted)

```bash
# a) Provision nginx + Let's Encrypt cert on the VPS (idempotent; registers the
#    host in /root/app-domains.conf so the 2-minute sync timer keeps nginx
#    pointed at the current app container across Coolify redeploys):
ssh root@64.227.154.215 /root/deepify-add-domain.sh app share.lakeb2b.com glqeabg3bi 8000

# a0) BEFORE the flip: final resync from Railway (production keeps taking writes
#     until DNS moves, so the last sync must be immediately pre-cutover).
#     Railway's proxy host/port/password ROTATE — always re-read them first:
#       railway link --project ChampBeam --environment production --service Postgres
#       railway variables --service Postgres      # RAILWAY_TCP_PROXY_DOMAIN/PORT, PGPASSWORD
#       railway variables --service MongoDB       # same, for the GridFS blobs
#     Cached copies live in ~/Celsus/Other/.secrets/champbeam_railway_{db,mongo}_url.
#
#     !! The resync TRUNCATEs and reloads the app tables, which CASCADES into
#     api_keys and the service-key identity. After every resync, re-provision:
#       - user  service+champ-workspace@championsmail.com  + its org membership
#       - any API keys issued from Settings (they must be re-created by the user)
#     Otherwise the agent-workspace integration and all cb_live_ keys break.

# b) Point the platform back at the branded host (Coolify env) and restart:
#    REDIRECT_BASE_URL=https://share.lakeb2b.com
#    PLATFORM_REDIRECT_HOST=share.lakeb2b.com,champbeam-api.64.227.154.215.sslip.io
#    (order matters: the FIRST host is what new links/pages/shares are minted on.
#    Pre-cutover it is deliberately sslip-first so API/workspace-minted URLs are
#    live immediately; at cutover flip it back so new URLs carry the brand host.
#    Old sslip-minted URLs keep working — both hosts stay in the platform set.)
#    (Coolify app uuid: glqeabg3bi476iam4cgbg01g)

# c) Verify:
curl -sI https://share.lakeb2b.com/health          # 200, valid cert
# open any file share link from the app; analytics event should record with geo
```

Because serve URLs are computed at read time, every existing file immediately
mints `share.lakeb2b.com` links after the env flip — no data migration needed.

## 3. Optional follow-ups for IT (unlocks full self-serve domains)

The app already ships a complete custom-domain feature (BYOD verification +
in-app purchase). Two Cloudflare-side items unlock its automated tier:

### a) Cloudflare for SaaS (automatic certs for customer domains)
- lakeb2b.com zone → SSL/TLS → Custom Hostnames: enable.
- Add DNS record `champbeam-origin.lakeb2b.com` → A `64.227.154.215` (DNS only)
  and set it as the **fallback origin**.
- Add `cname.lakeb2b.com` → CNAME `champbeam-origin.lakeb2b.com` (proxied).
  Customers then CNAME their domain to `cname.lakeb2b.com` and Cloudflare
  issues their edge certificates automatically (first 100 hostnames free).

### b) Scoped API token (enables the backend integration + in-app domain purchase)
Create at dash.cloudflare.com → My Profile → API Tokens with:
- Zone → DNS → Edit (lakeb2b.com)
- Zone → SSL and Certificates → Edit (lakeb2b.com)
- Account → Registrar → Edit  (only if in-app domain **purchase** is wanted;
  the account also needs a payment method + verified registrant contact)

Then set on the Coolify app (and restart):

| Env var | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | the token |
| `CLOUDFLARE_ZONE_ID` | lakeb2b.com zone id (dashboard Overview, right column) |
| `CLOUDFLARE_CNAME_TARGET` | `cname.lakeb2b.com` |
| `CLOUDFLARE_ACCOUNT_ID` | account id (purchase only) |
| `CLOUDFLARE_REGISTRANT_EMAIL` | registrant contact email (purchase only) |

## Interim state (until step 1 happens)

- Platform share host: `champbeam-api.64.227.154.215.sslip.io`
  (`REDIRECT_BASE_URL` on the Coolify app).
- Customer BYOD domains work without Cloudflare and are now **fully
  self-serve**: the customer adds a domain in Settings and points a CNAME at
  `BYOD_CNAME_TARGET` (a DNS-only hostname resolving to the VPS IP). The
  backend's DNS pre-check advances the domain to `pending_ssl`, and a systemd
  timer on the VPS (`deploy/provisioner/`, wrapping the proven
  `/root/deepify-add-domain.sh app <hostname> glqeabg3bi 8000`) issues the
  nginx vhost + cert and flips the domain to Active — no manual script runs.
  Backend env: `PLATFORM_IPV4`, `BYOD_CNAME_TARGET`, `PROVISIONER_TOKEN`
  (see deploy/provisioner/README.md for the one-time install). With
  Cloudflare-for-SaaS (3a above) the VPS provisioning disappears entirely.
