# DNS

Production hostnames `champbeam.com` and `www.champbeam.com` are custom domains on the Cloudflare Worker `champbeam`. Staging is `staging.champbeam.com` on the wrangler environment `staging`. Attach and check them from the Worker settings. Deploy notes: [CLOUDFLARE_DEPLOY.md](../CLOUDFLARE_DEPLOY.md).

Do not point `champbeam.com` at a droplet. Customer hostnames use Cloudflare for SaaS (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ZONE_ID`, `CLOUDFLARE_CNAME_TARGET`), not a per-host certificate on a VPS.

The July 2026 VPS runbook (apex and share records aimed at a droplet) is retired. It is not reproduced here. The old steps remain in git history.
