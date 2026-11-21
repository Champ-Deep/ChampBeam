# DNS email

There is no pending DNS email for production. https://champbeam.com is the Cloudflare Worker (`worker/`). Do not send a request that points the apex at a droplet.

An older draft asked for a share-hostname change on a customer zone as part of the retired VPS cutover. That draft is not current and is not kept in this file. See [DNS_RUNBOOK.md](DNS_RUNBOOK.md) and [CLOUDFLARE_DEPLOY.md](../CLOUDFLARE_DEPLOY.md).
