# Champ fleet health monitor

This monitor runs on the retired VPS. It is not how https://champbeam.com is checked. The Worker health URL is `GET /health` on that host. The script below is the old box-level check.

One monitor for the tools that used to run on that VPS. It runs on the VPS
every 2 minutes and pages your phone through the same ntfy sink `hermes-guard`
already uses, so there is exactly one place that knows how to reach you.

## What it checks

| Check | Why it exists |
|---|---|
| Each tool's public URL (status + a required string in the body) | A 200 that serves the wrong build is still an outage |
| TLS certificate expiry (< 14 days) | Certs die quietly on a weekend |
| Root disk, available RAM, swap pressure | The box is 2 vCPU / 3.8 GB, it fills up |
| Unhealthy / exited containers | Coolify restarts things; sometimes they stay down |
| MaxMind credit balance, burn rate, run-out date | Geo enrichment stops silently when credits hit zero |

## Severity

`fail` pages immediately as **critical** and repeats every 6 h until it recovers.
`warn` nags once a day at **warning** severity. Recovery always pages once.
A check must fail twice in a row before it pages, so a redeploy blip stays quiet.

## Adding a tool

One line in `/root/champ-health.targets`:

```
ChampHarbinger API | https://champharbinger-api.64.227.154.215.sslip.io/health | 200 | ok
```

Nothing else changes. Comment a line out to silence a known-broken target.

## Install

```bash
scp champ-health.sh champ-health.targets root@64.227.154.215:/root/
scp champ-health.service champ-health.timer root@64.227.154.215:/etc/systemd/system/
ssh root@64.227.154.215 'chmod +x /root/champ-health.sh && systemctl daemon-reload && systemctl enable --now champ-health.timer'
```

Copy `champ-health.env.example` to `/root/champ-health.env` (chmod 600) and put a
`cb_live_` API key in it. The key must exist in the database of whichever
ChampBeam you point `CHAMPBEAM_API` at, Railway and the VPS have separate databases.

## Commands

```bash
/root/champ-health.sh --dry-run   # one pass, print only, never alerts
/root/champ-health.sh --test      # prove the alert path reaches your phone
```

## The blind spot, and how it is covered

A monitor running on the box cannot report the box being dead. Every pass writes
`/var/www/fleet/fleet-status.json` with a `checked_at` timestamp. Point one
**external** check (the existing hourly cloud routine, or a free UptimeRobot
keyword monitor) at that file and alert if it is missing or older than ~10
minutes. That is the dead-man's switch, and it is the only check that must not
live on this server.
