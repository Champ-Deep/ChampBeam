# Geo / IP intelligence — providers & the "life after MaxMind" plan

We resolve an IP into **location + ISP + VPN/proxy flags** for every open. This
doc is the contract and the exit strategy: how the provider layer is structured,
how to run MaxMind today, and exactly how we drop or swap MaxMind later without a
migration or downtime.

TL;DR — we are **not locked in**. Providers sit behind one normalized function
and one dict shape. Removing MaxMind is unsetting two env vars; the chain falls
through to the next provider. Historical data is untouched because geo is stored
on each open, not recomputed.

---

## The seam that keeps us provider-agnostic

Everything geo goes through **one function**:

```python
# app/services/geoip_service.py
async def lookup_ip(ip: str) -> Optional[dict]
```

and every provider returns the **same normalized dict** (or `None`):

```python
{
  "country": str | None,        # full name when available, else ISO code
  "country_code": str | None,   # ISO 3166-1 alpha-2
  "region": str | None,
  "city": str | None,
  "latitude": float | None,
  "longitude": float | None,
  "is_vpn": bool | None,        # VPN / proxy / hosting / Tor
  "asn_org": str | None,        # ISP / network owner (AS number stripped)
}
```

Callers (click tracking, `resolve_geo_for_event`, the `/analytics/geo` and
`/analytics/company-intent` endpoints) **only ever see this dict** — never a
MaxMind, IPinfo, or ip-api object. That is the whole point: swapping the provider
never touches call sites.

Two rules every provider obeys:

1. **Fail open.** Any error (quota, auth, network, address-not-found) returns
   `None`, never raises. Geo must never break a redirect or a file open.
2. **Config-gated.** A provider that isn't configured returns `None` immediately
   and makes no network call, so the chain simply moves to the next one.

Company firmographics ("which company opened this") is a **separate** seam,
`app/services/company_intel.py`, with its own provider switch — see
`company_intel_provider`. Same philosophy, different concern.

---

## Provider chain (current)

`lookup_ip` tries providers in order and returns the first hit:

| # | Provider | Config | Datacenter-safe? | VPN flags? | Cost |
|---|----------|--------|:---:|:---:|------|
| 1 | **MaxMind GeoLite2 local DB** (City + ASN `.mmdb`) | `MAXMIND_LICENSE_KEY` (+ boot download) | ✅ (local) | ASN-inferred | Free |
| 2 | **MaxMind GeoIP2 web service / Insights** | `MAXMIND_ACCOUNT_ID` + `MAXMIND_LICENSE_KEY` | ✅ HTTPS | ✅ real anonymizer traits | Paid per query |
| 3 | **IPinfo** web service | `IPINFO_API_TOKEN` | ✅ HTTPS | ✅ (privacy add-on) or ASN | Free tier / paid |
| 4 | **ip-api.com** | none | ❌ blocks datacenter IPs | proxy/hosting | Free (rate-limited) |

Each row is independent. Configure one, several, or all — the chain uses whatever
is present, best-first. **This is why "Unknown" happened in prod**: only #1 and #4
were viable, #1's DB was never installed, and #4 blocks Railway's datacenter IP.
Adding a datacenter-safe web service (#2 or #3) is the fix.

### Running MaxMind today (our choice: Insights)

```bash
MAXMIND_ACCOUNT_ID=<your account id>
MAXMIND_LICENSE_KEY=<license key for that account>
MAXMIND_WS_HOST=geoip.maxmind.com     # default; paid GeoIP2 host (Insights lives here)
MAXMIND_WS_ENDPOINT=insights          # default; 'city' is cheaper but has no VPN flags
```

`insights` gives the richest data (confidence + full anonymizer traits:
`is_anonymous_vpn`, `is_public_proxy`, `is_hosting_provider`, `is_tor_exit_node`,
`is_residential_proxy`). Downgrade to `city` to cut cost if VPN flags stop
mattering. To use the **free GeoLite2 web service** instead, set
`MAXMIND_WS_HOST=geolite.info` and `MAXMIND_WS_ENDPOINT=city`.

Prefer $0 and can mount a volume? Use the **local DB** path instead (row #1):
set only `MAXMIND_LICENSE_KEY`; boot's `ensure_geoip.py` downloads GeoLite2
City + ASN. No per-query cost, no anonymizer traits (VPN is ASN-inferred).

---

## Life after MaxMind

Three levels, cheapest-effort first.

### 1. Turn MaxMind off (zero code) — instant
Unset `MAXMIND_ACCOUNT_ID` / `MAXMIND_LICENSE_KEY` (and delete any local
`.mmdb`). `maxmind_ws_configured` becomes `False`, the local readers don't load,
and `lookup_ip` falls straight through to **IPinfo** (set `IPINFO_API_TOKEN`) or
**ip-api**. No deploy of code, no migration. Set IPinfo *before* you pull MaxMind
so there's never a gap.

### 2. Swap in a different provider — ~30 minutes, one file
Because of the normalized dict, adding a provider is a self-contained function.
Pattern (mirrors `_lookup_maxmind_ws` / `_lookup_ipinfo`):

```python
async def _lookup_<name>(ip: str) -> Optional[dict]:
    if not settings.<name>_configured:      # config gate
        return None
    try:
        ... HTTPS call ...
    except Exception:                        # fail open
        return None
    return { "country": ..., "country_code": ..., "region": ...,
             "city": ..., "latitude": ..., "longitude": ...,
             "is_vpn": ..., "asn_org": ... }   # normalized shape
```

Then add it to the two fallback lines in `lookup_ip`, add config fields +
a `<name>_configured` property, and add a test file mirroring
`test_geoip_maxmind_ws.py` with new `GEO-*` ids in `docs/TESTING.md`. Done.

Drop-in alternatives that fit the same dict (all HTTPS, datacenter-safe):

| Alternative | Geo | VPN/proxy | Notes |
|-------------|:---:|:---:|-------|
| **IPinfo** (already wired) | ✅ | ✅ (privacy add-on) | Generous free tier; simplest swap |
| **DB-IP** | ✅ | partial | Free Lite `.mmdb` (geoip2-compatible reader) or API |
| **ipregistry** / **ipgeolocation.io** | ✅ | ✅ | Security/VPN fields in one call |
| **Abstract / ipdata** | ✅ | ✅ | Threat + company fields |
| **IP2Location** | ✅ | ✅ (proxy DB) | DB or API |

### 3. Fully delete MaxMind — cleanup PR
1. Remove the two `_lookup_maxmind_ws(...)` calls from `lookup_ip`.
2. Delete `_lookup_maxmind_ws` and the local-DB readers if unused.
3. Remove `maxmind_*` config fields + `maxmind_ws_configured`, and the
   `ensure_geoip.py` boot step.
4. Delete `test_geoip_maxmind_ws.py` and its `GEO-6..9` rows in `docs/TESTING.md`.
Everything downstream is unchanged — it only ever saw the dict.

---

## Data continuity (why swaps are safe)

Geo is **denormalized onto each open** (`ClickEvent` / `LinkClick` carry
`country`, `region`, `city`, `latitude`, `longitude`, `is_vpn`, ISP). We resolve
once, at open time, and store the result. Consequences:

- Switching providers changes **only new opens**. Historical rows keep the values
  the old provider gave them — no backfill, no migration, no analytics gap.
- Analytics endpoints (`/analytics/geo`, `/analytics/company-intent`) read the
  stored columns, so they're provider-agnostic by construction.
- If you *want* to re-resolve history after a swap, that's an optional one-off
  backfill job over stored IPs — never required to change providers.

---

## Cost & resilience controls

- **Quota exhaustion is not an outage.** A provider over quota returns `None` →
  the chain uses the next one. Always keep a free fallback (`ip-api`, or IPinfo
  free tier) configured beneath the paid provider.
- **Cut query volume**: cache `lookup_ip` by IP with a short TTL (opens from the
  same viewer/office reuse the result); most spend is repeat IPs.
- **Cut per-query price**: downgrade `MAXMIND_WS_ENDPOINT` `insights → city`, or
  move to the local GeoLite2 DB ($0) and accept ASN-inferred VPN.
- **Monitor**: log provider + latency on each resolve; alert on a rising `None`
  rate (early signal of quota/auth trouble) before it shows up as "Unknown".
