# ChampBeam BYOD provisioner (VPS host side)

Makes bring-your-own-domain fully self-serve on the self-hosted deployment:
customer adds a domain in Settings → points their CNAME at
`BYOD_CNAME_TARGET` → the backend's DNS pre-check advances the domain to
`pending_ssl` → this timer (on the VPS host) issues the nginx vhost +
Let's Encrypt cert via the proven `/root/deepify-add-domain.sh` → the domain
flips to `active`. No human in the loop.

## Install (once, on the VPS as root)

```bash
# 1. Copy files
scp champbeam-provisioner.sh root@64.227.154.215:/root/champbeam-provisioner.sh
scp champbeam-provisioner.service champbeam-provisioner.timer root@64.227.154.215:/etc/systemd/system/
ssh root@64.227.154.215 chmod +x /root/champbeam-provisioner.sh

# 2. Shared secret (must equal the backend's PROVISIONER_TOKEN env in Coolify)
ssh root@64.227.154.215 'umask 077 && echo "PROVISIONER_TOKEN=<token>" > /root/champbeam-provisioner.env'

# 3. Enable
ssh root@64.227.154.215 'systemctl daemon-reload && systemctl enable --now champbeam-provisioner.timer'
```

Requires `jq` on the host (`apt-get install -y jq`).

## Backend configuration (Coolify env on the app)

- `PLATFORM_IPV4=64.227.154.215`
- `BYOD_CNAME_TARGET=<a DNS-only hostname resolving to that IP>` — must be
  grey-cloud/unproxied, otherwise customers' CNAMEs resolve to Cloudflare edge
  IPs and the DNS pre-check never passes.
- `PROVISIONER_TOKEN=<same token as step 2>`

## Safety properties

- The work list only ever contains hostnames a user registered through the app
  (format-validated, platform hosts rejected) whose DNS already resolves to
  this VPS — the daemon cannot be steered into issuing certs for arbitrary
  names.
- Max 3 provisioning attempts per domain, then it parks in `failed` (caps
  Let's Encrypt rate-limit exposure).
- The script refuses to touch any nginx vhost not registered in
  `/root/app-domains.conf` (protects the platform hosts and other Deepify
  apps sharing this nginx).

## Watch it work

```bash
systemctl list-timers | grep champbeam
journalctl -u champbeam-provisioner.service -f
```
