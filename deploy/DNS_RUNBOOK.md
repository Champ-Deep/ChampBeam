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

# b) Point the platform back at the branded host (Coolify env) and restart:
#    REDIRECT_BASE_URL=https://share.lakeb2b.com
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
- Customer BYOD domains work today without Cloudflare (verified live with
  beam.deependhq.com): the customer adds a CNAME to the platform host, and we
  provision the cert on the VPS with
  `/root/deepify-add-domain.sh app <hostname> glqeabg3bi 8000`
  (nginx server block + certbot + auto-heal registration, idempotent). The
  app's Settings → Domains "Refresh" button flips the domain to Active once it
  routes here with a valid cert. With Cloudflare-for-SaaS (3a above) this
  per-domain VPS step disappears entirely.
