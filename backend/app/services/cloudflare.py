"""Cloudflare for SaaS — Custom Hostnames API client.

Thin async wrapper around the three CF API calls we need:
- create a custom hostname (sets up cert issuance + SNI routing)
- read its current SSL/validation status
- delete it

When ``settings.cloudflare_configured`` is False the client raises
``CloudflareNotConfigured`` so callers can fall back to local-only mode
(useful for development without a CF account).
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

from app.core.config import settings

logger = logging.getLogger(__name__)


API_BASE = "https://api.cloudflare.com/client/v4"


class CloudflareError(Exception):
    """Raised when the CF API returns a non-success response."""


class CloudflareNotConfigured(Exception):
    """Raised when CF credentials are missing — caller should fall back."""


def _require_configured() -> tuple[str, str]:
    if not settings.cloudflare_configured:
        raise CloudflareNotConfigured(
            "Cloudflare integration is not configured "
            "(set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ZONE_ID)."
        )
    return settings.cloudflare_api_token, settings.cloudflare_zone_id


def _headers(token: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }


async def create_custom_hostname(hostname: str) -> dict[str, Any]:
    """Register a Custom Hostname with HTTP-validated SSL.

    Returns the CF result dict (includes ``id``, ``status``, ``ssl``).
    """
    token, zone_id = _require_configured()
    body = {
        "hostname": hostname,
        "ssl": {
            "method": "http",
            "type": "dv",
            "settings": {"min_tls_version": "1.2"},
        },
    }
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(
            f"{API_BASE}/zones/{zone_id}/custom_hostnames",
            json=body,
            headers=_headers(token),
        )
    return _unwrap(resp, f"create_custom_hostname({hostname})")


async def get_custom_hostname(custom_hostname_id: str) -> dict[str, Any]:
    """Read the current state of a Custom Hostname."""
    token, zone_id = _require_configured()
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(
            f"{API_BASE}/zones/{zone_id}/custom_hostnames/{custom_hostname_id}",
            headers=_headers(token),
        )
    return _unwrap(resp, f"get_custom_hostname({custom_hostname_id})")


async def delete_custom_hostname(custom_hostname_id: str) -> None:
    """Remove a Custom Hostname. Idempotent: a 404 is treated as success."""
    token, zone_id = _require_configured()
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.delete(
            f"{API_BASE}/zones/{zone_id}/custom_hostnames/{custom_hostname_id}",
            headers=_headers(token),
        )
    if resp.status_code == 404:
        return
    _unwrap(resp, f"delete_custom_hostname({custom_hostname_id})")


def _unwrap(resp: httpx.Response, op: str) -> dict[str, Any]:
    try:
        body = resp.json()
    except ValueError:
        raise CloudflareError(f"{op}: non-JSON response (HTTP {resp.status_code})")
    if not resp.is_success or not body.get("success"):
        errors = body.get("errors") or [{"message": resp.text}]
        raise CloudflareError(f"{op}: {errors}")
    return body.get("result") or {}


def derive_status(cf_result: dict[str, Any]) -> tuple[str, str | None]:
    """Map a CF custom_hostname result into our (status, ssl_status) shape.

    CF's ``status`` covers ownership verification; ``ssl.status`` covers cert
    issuance. We collapse both into a single user-visible status:
      - ``pending_cname`` while CF reports ``pending``/``blocked`` on hostname
      - ``pending_ssl`` while ownership is verified but cert isn't issued
      - ``active`` when both reach ``active``
      - ``failed`` on moved/deleted/deactivated states
    """
    host_status = (cf_result.get("status") or "").lower()
    ssl_info = cf_result.get("ssl") or {}
    ssl_status = (ssl_info.get("status") or "").lower() or None

    if host_status in {"moved", "deleted", "deactivated"}:
        return "failed", ssl_status
    if host_status == "active" and ssl_status == "active":
        return "active", ssl_status
    if host_status == "active":
        return "pending_ssl", ssl_status
    return "pending_cname", ssl_status
