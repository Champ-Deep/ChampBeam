# Email to IT — share.lakeb2b.com DNS cutover

Copy the block below into an email. Everything else on the ChampBeam side is
already prepared and verified; this DNS record is the only remaining change.

---

**Subject:** DNS change request — share.lakeb2b.com (one record, ~2 minutes)

Hi team,

Please make the following DNS change in Cloudflare for the **lakeb2b.com** zone.
This moves our ChampBeam link/file sharing service to its new server. It is a
single record edit — nothing else in the zone changes.

**The change**

| Field | Value |
|---|---|
| Zone | lakeb2b.com |
| Record | `share.lakeb2b.com` |
| Type | **A** |
| Value / points to | **64.227.154.215** |
| Proxy status | **Proxied** (orange cloud) — unchanged from today |
| TTL | Auto |

If the record is currently a CNAME, please replace it with the A record above.

**One setting to confirm**

Under **SSL/TLS → Overview** for lakeb2b.com, the encryption mode should be
**Full**. If it is currently set to *Full (strict)*, please switch it to **Full**
for the cutover — we will confirm within a few minutes once traffic is flowing,
and you can set it back to Full (strict) afterwards if that is your standard.
(If it is already on *Flexible* or *Full*, no change is needed.)

**Timing / impact**

- Cloudflare applies proxied record changes at the edge almost immediately, so
  there is no waiting on TTL expiry.
- Existing links and QR codes that people have already shared continue to work
  unchanged — the hostname `share.lakeb2b.com` itself is not changing, only the
  server behind it. We have already tested this against the new server with our
  live production data.
- No user action, no re-issuing of links, no downtime expected.

**Please reply once the change is made** so we can run our post-cutover checks.

**Rollback** (only if we ask): set the record back to its previous value. The old
server stays running and untouched as a safety net.

Thanks,
Deep

---

## Notes for us (do not send)

- The old Railway backend stays running after the flip as a rollback target.
- The VPS already has the `share.lakeb2b.com` nginx vhost staged with a
  placeholder certificate, plus a systemd timer (`champbeam-certwatch.timer`)
  that detects the moment traffic reaches the new origin and automatically
  installs a real Let's Encrypt certificate, then disables itself. That is why
  "Full" is sufficient at the moment of the flip and strict can be restored
  right after.
- No Vercel change is needed: production `VITE_API_URL` is already
  `https://share.lakeb2b.com`, so the frontend follows the DNS automatically.
