"""Cloudflare Registrar API client (beta) for in-app domain procurement.

Wraps the account-scoped Registrar endpoints — search names, check
availability/price, register — plus the two follow-on calls used to wire a
freshly registered domain to this backend (find its new zone, add a CNAME).

When ``settings.cloudflare_registrar_configured`` is False the calls raise
``RegistrarNotConfigured`` so the API layer can answer 503 with a setup hint,
mirroring the Cloudflare-for-SaaS pattern in ``cloudflare.py``.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

import httpx

from app.core.config import settings

logger = logging.getLogger(__name__)

API_BASE = "https://api.cloudflare.com/client/v4"


class RegistrarError(Exception):
    """Raised when the Registrar API returns a non-success response."""


class RegistrarNotConfigured(Exception):
    """Raised when account id / token are missing; caller should 503."""


def _require_configured() -> tuple[str, str]:
    if not settings.cloudflare_registrar_configured:
        raise RegistrarNotConfigured(
            "Domain procurement is not configured "
            "(set CLOUDFLARE_API_TOKEN with Registrar write scope and CLOUDFLARE_ACCOUNT_ID)."
        )
    return settings.cloudflare_api_token, settings.cloudflare_account_id


def _headers(token: str, extra: Optional[dict[str, str]] = None) -> dict[str, str]:
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    if extra:
        headers.update(extra)
    return headers


def _unwrap(resp: httpx.Response, op: str) -> dict[str, Any]:
    try:
        body = resp.json()
    except ValueError:
        raise RegistrarError(f"{op}: non-JSON response (HTTP {resp.status_code})")
    if not resp.is_success or not body.get("success", True):
        errors = body.get("errors") or [{"message": resp.text}]
        raise RegistrarError(f"{op}: {errors}")
    return body.get("result") or {}


async def search(query: str, limit: int = 20) -> list[dict[str, Any]]:
    """Suggest registrable domains for a keyword. Returns the `domains` list."""
    token, account_id = _require_configured()
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(
            f"{API_BASE}/accounts/{account_id}/registrar/domain-search",
            params={"q": query, "limit": limit},
            headers=_headers(token),
        )
    return (_unwrap(resp, f"search({query})") or {}).get("domains", [])


async def check(domains: list[str]) -> list[dict[str, Any]]:
    """Check live availability + pricing for up to 20 exact domains."""
    token, account_id = _require_configured()
    async with httpx.AsyncClient(timeout=20) as client:
        resp = await client.post(
            f"{API_BASE}/accounts/{account_id}/registrar/domain-check",
            json={"domains": domains[:20]},
            headers=_headers(token),
        )
    return (_unwrap(resp, "check") or {}).get("domains", [])


async def register(
    domain_name: str,
    *,
    auto_renew: bool = False,
    contacts: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    """Register a domain. Returns the registration workflow result.

    Synchronous by default (CF waits up to ~10s); the result carries ``state``
    (succeeded | in_progress | action_required | failed | blocked) and, when
    complete, a ``context.registration`` block with expiry + status.
    """
    token, account_id = _require_configured()
    body: dict[str, Any] = {"domain_name": domain_name, "auto_renew": auto_renew}
    if contacts:
        body["contacts"] = contacts
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            f"{API_BASE}/accounts/{account_id}/registrar/registrations",
            json=body,
            headers=_headers(token),
        )
    return _unwrap(resp, f"register({domain_name})")


async def registration_status(domain_name: str) -> dict[str, Any]:
    """Poll the registration workflow for a domain."""
    token, account_id = _require_configured()
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(
            f"{API_BASE}/accounts/{account_id}/registrar/registrations/{domain_name}/registration-status",
            headers=_headers(token),
        )
    return _unwrap(resp, f"registration_status({domain_name})")


async def find_zone_id(domain_name: str) -> Optional[str]:
    """Resolve the zone id for a domain in our account (created on registration)."""
    token, account_id = _require_configured()
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(
            f"{API_BASE}/zones",
            params={"name": domain_name, "account.id": account_id},
            headers=_headers(token),
        )
    result = _unwrap_list(resp, f"find_zone_id({domain_name})")
    return result[0]["id"] if result else None


async def create_cname(zone_id: str, name: str, target: str, proxied: bool = True) -> dict[str, Any]:
    """Create a (proxied) CNAME record pointing ``name`` at ``target``."""
    token, _ = _require_configured()
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(
            f"{API_BASE}/zones/{zone_id}/dns_records",
            json={"type": "CNAME", "name": name, "content": target, "proxied": proxied, "ttl": 1},
            headers=_headers(token),
        )
    return _unwrap(resp, f"create_cname({name})")


def _unwrap_list(resp: httpx.Response, op: str) -> list[dict[str, Any]]:
    try:
        body = resp.json()
    except ValueError:
        raise RegistrarError(f"{op}: non-JSON response (HTTP {resp.status_code})")
    if not resp.is_success or not body.get("success", True):
        errors = body.get("errors") or [{"message": resp.text}]
        raise RegistrarError(f"{op}: {errors}")
    return body.get("result") or []


def derive_registration_state(result: dict[str, Any]) -> str:
    """Normalize a registration workflow result to a single state string."""
    state = (result.get("state") or "").lower()
    if result.get("completed") and state in ("", "succeeded"):
        return "succeeded"
    return state or "in_progress"
