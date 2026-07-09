"""GeoIP lookup service — provider-agnostic, best-first fallback chain.

`lookup_ip(ip)` returns a normalized dict (or None) and tries, in order:
  1. MaxMind GeoLite2 local .mmdb (City + ASN) — instant, unlimited, $0.
  2. MaxMind GeoIP2 web service / Insights — HTTPS, datacenter-safe, VPN traits.
  3. IPinfo web service — HTTPS, datacenter-safe.
  4. ip-api.com — free, HTTP, blocks datacenter IPs (last resort).

Each provider is independently configured and fails open (errors -> None so the
chain continues; geo never breaks click tracking). Adding/swapping/removing a
provider is documented in docs/GEO-PROVIDERS.md.
"""

from __future__ import annotations

import logging
import re
from typing import Optional

import httpx

from app.core.config import settings

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# MaxMind GeoLite2 readers (loaded once at module level, thread-safe)
# ---------------------------------------------------------------------------
_maxmind_reader = None
_maxmind_available = False
_asn_reader = None
_asn_available = False

try:
    import geoip2.database
    import geoip2.errors

    # City database (geo data)
    try:
        _maxmind_reader = geoip2.database.Reader(settings.maxmind_db_path)
        _maxmind_available = True
        logger.info("MaxMind GeoLite2-City loaded from %s", settings.maxmind_db_path)
    except FileNotFoundError:
        logger.warning(
            "MaxMind GeoLite2-City not found at %s, falling back to ip-api.com",
            settings.maxmind_db_path,
        )

    # ASN database (VPN/hosting detection)
    try:
        _asn_reader = geoip2.database.Reader(settings.maxmind_asn_db_path)
        _asn_available = True
        logger.info("MaxMind GeoLite2-ASN loaded from %s", settings.maxmind_asn_db_path)
    except FileNotFoundError:
        logger.warning(
            "MaxMind GeoLite2-ASN not found at %s, VPN detection will use ip-api.com fallback",
            settings.maxmind_asn_db_path,
        )
except ImportError:
    logger.warning("geoip2 package not installed, falling back to ip-api.com")


# ---------------------------------------------------------------------------
# ASN-based VPN/hosting detection
# ---------------------------------------------------------------------------
HOSTING_KEYWORDS = {
    # Major cloud providers
    "amazon", "aws", "google cloud", "microsoft", "azure",
    "digitalocean", "linode", "akamai", "vultr", "ovh",
    "hetzner", "cloudflare", "oracle", "alibaba cloud",
    "rackspace", "ibm cloud", "scaleway", "upcloud",
    # VPN providers
    "nordvpn", "expressvpn", "surfshark", "cyberghost",
    "private internet access", "mullvad", "protonvpn", "proton ag",
    "ipvanish", "tunnelbear", "windscribe", "hotspot shield",
    # Hosting companies
    "hostgator", "godaddy", "bluehost", "namecheap",
    "choopa", "m247", "datacamp", "psychz", "cogent",
    "quadranet", "leaseweb", "zscaler", "fortinet",
    # Generic hosting indicators
    "hosting", "datacenter", "data center", "colocation",
    "server", "cloud", "vps",
}


def _is_hosting_asn(asn_org: str | None) -> bool:
    """Check if an ASN organization name matches known hosting/VPN providers."""
    if not asn_org:
        return False
    org_lower = asn_org.lower()
    return any(keyword in org_lower for keyword in HOSTING_KEYWORDS)


def _lookup_asn(ip_address: str) -> dict | None:
    """Look up ASN data for an IP using the local GeoLite2-ASN database."""
    if not _asn_reader:
        return None
    try:
        response = _asn_reader.asn(ip_address)
        return {
            "asn_number": response.autonomous_system_number,
            "asn_org": response.autonomous_system_organization,
        }
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Private IP detection
# ---------------------------------------------------------------------------
_PRIVATE_IPS = {"127.0.0.1", "::1", "0.0.0.0"}


def _is_private_ip(ip: str) -> bool:
    """Check if an IP is private/loopback."""
    if ip in _PRIVATE_IPS:
        return True
    if ip.startswith(("10.", "192.168.", "172.16.", "172.17.", "172.18.",
                      "172.19.", "172.20.", "172.21.", "172.22.", "172.23.",
                      "172.24.", "172.25.", "172.26.", "172.27.", "172.28.",
                      "172.29.", "172.30.", "172.31.")):
        return True
    return False


# ---------------------------------------------------------------------------
# MaxMind City lookup
# ---------------------------------------------------------------------------
def _lookup_city(ip_address: str) -> Optional[dict]:
    """Look up geo data from the local GeoLite2-City database (no ASN)."""
    if not _maxmind_reader:
        return None
    try:
        response = _maxmind_reader.city(ip_address)
        return {
            "country": response.country.name,
            "country_code": response.country.iso_code,
            "region": response.subdivisions.most_specific.name if response.subdivisions else None,
            "city": response.city.name,
            "latitude": response.location.latitude,
            "longitude": response.location.longitude,
        }
    except geoip2.errors.AddressNotFoundError:
        logger.debug("MaxMind: IP not found in City database: %s", ip_address)
        return None
    except Exception as e:
        logger.debug("MaxMind City lookup failed for %s: %s", ip_address, e)
        return None


# ---------------------------------------------------------------------------
# ip-api.com fallback
# ---------------------------------------------------------------------------
async def _lookup_ipapi(ip_address: str) -> Optional[dict]:
    """Look up IP via ip-api.com free API (fallback)."""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(
                f"http://ip-api.com/json/{ip_address}",
                params={"fields": "status,country,countryCode,regionName,city,lat,lon,proxy,hosting,isp,org"},
            )
            data = resp.json()

        if data.get("status") != "success":
            return None

        return {
            "country": data.get("country"),
            "country_code": data.get("countryCode"),
            "region": data.get("regionName"),
            "city": data.get("city"),
            "latitude": data.get("lat"),
            "longitude": data.get("lon"),
            "is_vpn": bool(data.get("proxy") or data.get("hosting")),
            "asn_org": data.get("org") or data.get("isp"),
        }
    except Exception as e:
        logger.debug("ip-api.com lookup failed for %s: %s", ip_address, e)
        return None


# ---------------------------------------------------------------------------
# IPinfo lookup (HTTPS, works from datacenters — unlike free ip-api.com)
# ---------------------------------------------------------------------------
async def _lookup_ipinfo(ip_address: str) -> Optional[dict]:
    """Geo + ISP/VPN via IPinfo (reuses IPINFO_API_TOKEN from company intent).

    Returns None when no token is set or the call fails. Country is the ISO code
    (IPinfo doesn't return a full name on the base response); MaxMind supplies
    full names when its local DB is installed.
    """
    token = settings.ipinfo_api_token
    if not token:
        return None
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(
                f"https://ipinfo.io/{ip_address}/json",
                params={"token": token},
                headers={"Accept": "application/json"},
            )
        if resp.status_code >= 400:
            return None
        data = resp.json()
    except Exception as e:
        logger.debug("ipinfo lookup failed for %s: %s", ip_address, e)
        return None

    if data.get("bogon"):
        return None

    loc = (data.get("loc") or "").split(",")
    lat = float(loc[0]) if len(loc) == 2 and loc[0] else None
    lng = float(loc[1]) if len(loc) == 2 and loc[1] else None

    org = data.get("org")
    asn_org = re.sub(r"^AS\d+\s+", "", org).strip() if org else None

    privacy = data.get("privacy") or {}
    if privacy:
        is_vpn = bool(
            privacy.get("vpn") or privacy.get("proxy") or privacy.get("tor") or privacy.get("hosting")
        )
    else:
        # No privacy dataset on this plan — infer from the ASN owner.
        is_vpn = _is_hosting_asn(asn_org)

    cc = data.get("country")
    return {
        "country": cc,          # ISO code; MaxMind fills full names when present
        "country_code": cc,
        "region": data.get("region"),
        "city": data.get("city"),
        "latitude": lat,
        "longitude": lng,
        "is_vpn": is_vpn,
        "asn_org": asn_org,
    }


# ---------------------------------------------------------------------------
# MaxMind GeoIP2 web service (GeoIP Insights / City) — HTTPS, datacenter-safe
# ---------------------------------------------------------------------------
async def _lookup_maxmind_ws(ip_address: str) -> Optional[dict]:
    """Geo + ISP/VPN via the MaxMind GeoIP2 web service (GeoIP Insights).

    Unlike the local .mmdb readers this is an HTTPS REST call, so it works from
    datacenters / any PaaS where ip-api.com's free tier is blocked — this is the
    path that fixes "Unknown" geo in production. The Insights endpoint returns
    anonymizer traits (VPN / proxy / hosting / Tor / residential proxy) for VPN
    detection; the City endpoint returns geo + ASN but no anonymizer flags (we
    fall back to ASN-owner inference there). Returns None when unconfigured or on
    any error — geo must never break click tracking (fail open).
    """
    if not settings.maxmind_ws_configured:
        return None
    try:
        import geoip2.webservice

        account_id = int(str(settings.maxmind_account_id).strip())
    except (ImportError, ValueError):
        return None

    endpoint = (settings.maxmind_ws_endpoint or "insights").lower()
    try:
        async with geoip2.webservice.AsyncClient(
            account_id,
            settings.maxmind_license_key,
            host=settings.maxmind_ws_host or "geoip.maxmind.com",
        ) as client:
            if endpoint == "country":
                resp = await client.country(ip_address)
            elif endpoint == "city":
                resp = await client.city(ip_address)
            else:
                resp = await client.insights(ip_address)
    except Exception as e:  # noqa: BLE001 - AddressNotFound/auth/quota/network -> fail open
        logger.debug("MaxMind web service lookup failed for %s: %s", ip_address, e)
        return None

    country = getattr(resp, "country", None)
    subdivisions = getattr(resp, "subdivisions", None)
    try:
        region = subdivisions.most_specific.name if subdivisions else None
    except Exception:  # noqa: BLE001 - empty subdivisions raises IndexError
        region = None
    location = getattr(resp, "location", None)
    traits = getattr(resp, "traits", None)

    asn_org = None
    if traits is not None:
        asn_org = (
            getattr(traits, "isp", None)
            or getattr(traits, "autonomous_system_organization", None)
            or getattr(traits, "organization", None)
        )

    if endpoint == "insights" and traits is not None:
        is_vpn = bool(
            getattr(traits, "is_anonymous_vpn", False)
            or getattr(traits, "is_public_proxy", False)
            or getattr(traits, "is_tor_exit_node", False)
            or getattr(traits, "is_hosting_provider", False)
            or getattr(traits, "is_residential_proxy", False)
            or getattr(traits, "is_anonymous", False)
        )
    else:
        # City/Country endpoints carry no anonymizer flags — infer from the owner.
        is_vpn = _is_hosting_asn(asn_org)

    return {
        "country": getattr(country, "name", None) or getattr(country, "iso_code", None),
        "country_code": getattr(country, "iso_code", None),
        "region": region,
        "city": getattr(getattr(resp, "city", None), "name", None),
        "latitude": getattr(location, "latitude", None) if location else None,
        "longitude": getattr(location, "longitude", None) if location else None,
        "is_vpn": is_vpn,
        "asn_org": asn_org,
    }


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------
async def lookup_ip(ip_address: str) -> Optional[dict]:
    """Look up geographic info for an IP address.

    Provider order (each is optional and independently configured):
      1. MaxMind GeoLite2 local databases (City + ASN) — instant, unlimited.
      2. MaxMind GeoIP2 web service / Insights — HTTPS, datacenter-safe, VPN flags.
      3. IPinfo web service — HTTPS, datacenter-safe.
      4. ip-api.com free API — HTTP, blocks datacenter IPs (last resort).

    Returns dict with keys: country, country_code, region, city, latitude,
    longitude, is_vpn, asn_org.
    Returns None if lookup fails or IP is private/invalid.
    """
    if not ip_address or _is_private_ip(ip_address):
        return None

    # Local MaxMind lookups are independent: City (geo) and ASN (ISP/VPN) come
    # from separate databases, so resolve each on its own. This way ISP/VPN
    # detection keeps working even when the City DB lacks the IP, or when only
    # the ASN DB is installed.
    geo = _lookup_city(ip_address) if _maxmind_reader else None
    asn = _lookup_asn(ip_address) if _asn_reader else None

    if geo or asn:
        result = geo or {
            "country": None, "country_code": None, "region": None,
            "city": None, "latitude": None, "longitude": None,
        }
        if asn and asn.get("asn_org"):
            result["asn_org"] = asn["asn_org"]
            result["is_vpn"] = _is_hosting_asn(asn["asn_org"])
            return result
        # No local ASN data — top up ISP/VPN from a datacenter-safe web service:
        # MaxMind GeoIP2 (Insights) first, then IPinfo, then ip-api as a last
        # resort.
        vpn_result = (
            await _lookup_maxmind_ws(ip_address)
            or await _lookup_ipinfo(ip_address)
            or await _lookup_ipapi(ip_address)
        )
        if vpn_result:
            result["asn_org"] = vpn_result.get("asn_org")
            result["is_vpn"] = vpn_result.get("is_vpn")
        else:
            result.setdefault("asn_org", None)
            result.setdefault("is_vpn", None)
        return result

    # No local databases: use a datacenter-safe web service. MaxMind GeoIP2
    # (Insights) is the chosen primary; IPinfo and the free ip-api.com (which
    # blocks datacenter IPs) remain as ordered fallbacks.
    return (
        await _lookup_maxmind_ws(ip_address)
        or await _lookup_ipinfo(ip_address)
        or await _lookup_ipapi(ip_address)
    )
