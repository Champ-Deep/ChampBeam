"""GeoIP lookup service with MaxMind GeoLite2 (primary) and ip-api.com (fallback).

MaxMind GeoLite2 uses local .mmdb database files for fast, unlimited lookups.
- GeoLite2-City: geo data (country, region, city, lat/lon)
- GeoLite2-ASN: ASN data for VPN/hosting detection (no more ip-api.com rate limits)

Falls back to ip-api.com free API if the database files are not available.
"""

from __future__ import annotations

import logging
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
# MaxMind lookup (City + ASN combined)
# ---------------------------------------------------------------------------
def _lookup_maxmind(ip_address: str) -> Optional[dict]:
    """Look up IP using the local MaxMind GeoLite2 databases (City + ASN)."""
    if not _maxmind_reader:
        return None

    try:
        response = _maxmind_reader.city(ip_address)

        # ASN-based VPN detection
        asn_data = _lookup_asn(ip_address)
        asn_org = asn_data["asn_org"] if asn_data else None
        is_vpn = _is_hosting_asn(asn_org) if _asn_available else None

        return {
            "country": response.country.name,
            "country_code": response.country.iso_code,
            "region": response.subdivisions.most_specific.name if response.subdivisions else None,
            "city": response.city.name,
            "latitude": response.location.latitude,
            "longitude": response.location.longitude,
            "is_vpn": is_vpn,
            "asn_org": asn_org,
        }
    except geoip2.errors.AddressNotFoundError:
        logger.debug("MaxMind: IP not found in database: %s", ip_address)
        return None
    except Exception as e:
        logger.debug("MaxMind lookup failed for %s: %s", ip_address, e)
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
# Public API
# ---------------------------------------------------------------------------
async def lookup_ip(ip_address: str) -> Optional[dict]:
    """Look up geographic info for an IP address.

    Uses MaxMind GeoLite2 local databases if available (instant, unlimited).
    Falls back to ip-api.com free API otherwise (rate-limited, HTTP).

    Returns dict with keys: country, country_code, region, city, latitude,
    longitude, is_vpn, asn_org.
    Returns None if lookup fails or IP is private/invalid.
    """
    if not ip_address or _is_private_ip(ip_address):
        return None

    # Try MaxMind first (synchronous, fast local lookup)
    if _maxmind_available:
        result = _lookup_maxmind(ip_address)
        if result:
            # If ASN DB is missing, is_vpn will be None, fall through to ip-api
            if result.get("is_vpn") is not None:
                return result
            # ASN DB not available, try ip-api for VPN detection only
            vpn_result = await _lookup_ipapi(ip_address)
            if vpn_result:
                result["is_vpn"] = vpn_result.get("is_vpn")
                result["asn_org"] = vpn_result.get("asn_org")
            return result

    # Full fallback to ip-api.com
    if settings.geoip_provider == "ipapi" or not _maxmind_available:
        return await _lookup_ipapi(ip_address)

    return None
