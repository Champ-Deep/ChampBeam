"""GeoIP lookup service using ip-api.com free API."""

from __future__ import annotations

import logging
from typing import Optional

import httpx

logger = logging.getLogger(__name__)


async def lookup_ip(ip_address: str) -> Optional[dict]:
    """Look up geographic info for an IP address via ip-api.com.

    Returns dict with keys: country, country_code, region, city.
    Returns None if lookup fails or IP is private/invalid.
    """
    if not ip_address or ip_address in ("127.0.0.1", "::1"):
        return None

    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(
                f"http://ip-api.com/json/{ip_address}",
                params={"fields": "status,country,countryCode,regionName,city"},
            )
            data = resp.json()

        if data.get("status") != "success":
            return None

        return {
            "country": data.get("country"),
            "country_code": data.get("countryCode"),
            "region": data.get("regionName"),
            "city": data.get("city"),
        }
    except Exception as e:
        logger.debug("GeoIP lookup failed for %s: %s", ip_address, e)
        return None
