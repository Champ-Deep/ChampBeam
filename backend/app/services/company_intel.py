"""Company intent — reverse-IP firmographic enrichment (provider-agnostic).

An open's IP is resolved to a *company* (name, domain, industry, type) so the
analytics can show "which companies are opening your links." The provider is
pluggable so we can start cheap and upgrade match rate later without touching
the app:

- ``none``   : disabled.
- ``asn``    : $0. No external call — analytics reuse the ASN/network owner we
               already resolve via MaxMind (``ClickEvent.asn_org``). Rough
               "network" signal, no firmographics. ``resolve_company`` returns
               ``None`` (nothing to store); the aggregation falls back to asn_org.
- ``ipinfo`` : IPinfo's IP-to-Company add-on. Returns real company name/domain/
               type when the token's plan includes the company dataset.

Every provider returns the same normalized shape (or ``None``):

    {"name", "domain", "industry", "size", "type"}

so swapping to Warmly / HubSpot Breeze / 6sense later is a new adapter, nothing
else. All lookups are best-effort: any error or miss returns ``None`` so a slow
or failing provider never blocks the (background) enrichment task.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

import httpx

from app.core.config import settings

logger = logging.getLogger(__name__)


def _norm(value: Any) -> Optional[str]:
    if value is None:
        return None
    s = str(value).strip()
    return s or None


async def resolve_company(ip_address: str, *, timeout: float = 5.0) -> Optional[dict]:
    """Resolve an IP to firmographic company data, or ``None``.

    Returns ``None`` for the ``none``/``asn`` providers (nothing to persist) and
    for any lookup that misses or errors.
    """
    if not ip_address:
        return None
    provider = (settings.company_intel_provider or "none").lower()
    if provider == "ipinfo":
        return await _ipinfo(ip_address, timeout=timeout)
    # "none" and "asn" store nothing (asn reuses the existing asn_org column).
    return None


async def _ipinfo(ip_address: str, *, timeout: float) -> Optional[dict]:
    token = settings.ipinfo_api_token
    if not token:
        return None
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.get(
                f"https://ipinfo.io/{ip_address}/json",
                params={"token": token},
                headers={"Accept": "application/json"},
            )
        if resp.status_code >= 400:
            logger.warning("ipinfo lookup %s -> %s", ip_address, resp.status_code)
            return None
        data = resp.json()
    except Exception:  # noqa: BLE001 — enrichment must never raise into the task
        logger.warning("ipinfo lookup failed for %s", ip_address, exc_info=True)
        return None

    # The firmographic payload lives under `company` on plans that include the
    # IP-to-Company dataset. Only treat a real company object as a match — the
    # bare `org` (ASN) is the free "network" signal handled by the asn provider.
    company = data.get("company")
    if not isinstance(company, dict):
        return None
    name = _norm(company.get("name"))
    if not name:
        return None
    return {
        "name": name,
        "domain": _norm(company.get("domain")),
        "industry": _norm(company.get("industry")),
        "size": _norm(company.get("size")),
        "type": _norm(company.get("type")),  # business|isp|hosting|education|…
    }
