"""Thin client for the Clerk Backend API + webhook (svix) signature checks.

Two jobs:
- ``fetch_user`` pulls a user's real email/name from Clerk so the local mirror
  isn't stuck on the ``{id}@clerk.placeholder`` stub created on first auth.
- ``verify_webhook`` validates the svix signature on POST /webhooks/clerk so we
  can trust ``user.*`` / ``organization*`` events without a third-party lib.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import time
from typing import Any, Optional

import httpx

from app.core.config import settings

logger = logging.getLogger(__name__)

# Reject webhook timestamps older/newer than this (replay protection), in
# seconds. Matches svix's default tolerance.
_WEBHOOK_TOLERANCE_SECONDS = 5 * 60


async def fetch_user(clerk_user_id: str) -> Optional[dict[str, Any]]:
    """GET the Clerk user record. Returns None on any failure (best-effort)."""
    if not settings.clerk_secret_key:
        return None
    url = f"{settings.clerk_api_url.rstrip('/')}/v1/users/{clerk_user_id}"
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            resp = await client.get(
                url, headers={"Authorization": f"Bearer {settings.clerk_secret_key}"}
            )
        if resp.status_code != 200:
            logger.warning("clerk fetch_user %s -> HTTP %s", clerk_user_id, resp.status_code)
            return None
        return resp.json()
    except httpx.HTTPError:
        logger.warning("clerk fetch_user network error for %s", clerk_user_id, exc_info=True)
        return None


def primary_email(user_payload: dict[str, Any]) -> Optional[str]:
    """Pull the primary email from a Clerk user payload (API or webhook shape)."""
    if not user_payload:
        return None
    primary_id = user_payload.get("primary_email_address_id")
    addresses = user_payload.get("email_addresses") or []
    for addr in addresses:
        if addr.get("id") == primary_id and addr.get("email_address"):
            return addr["email_address"]
    # Fall back to the first verified/any address.
    for addr in addresses:
        if addr.get("email_address"):
            return addr["email_address"]
    return None


def full_name(user_payload: dict[str, Any]) -> Optional[str]:
    if not user_payload:
        return None
    first = (user_payload.get("first_name") or "").strip()
    last = (user_payload.get("last_name") or "").strip()
    name = (first + " " + last).strip()
    return name or None


def verify_webhook(headers: dict[str, str], body: bytes) -> bool:
    """Verify a Clerk (svix) webhook signature against CLERK_WEBHOOK_SECRET.

    Implements the svix scheme directly: HMAC-SHA256 over
    ``"{id}.{timestamp}.{body}"`` keyed by the base64-decoded secret, compared
    constant-time against any of the space-separated ``v1,<sig>`` values in the
    ``svix-signature`` header. Also enforces a timestamp tolerance.
    """
    secret = settings.clerk_webhook_secret
    if not secret:
        return False
    # Headers may arrive with either svix-* (raw) or webhook-* (proxied) names.
    lower = {k.lower(): v for k, v in headers.items()}
    svix_id = lower.get("svix-id") or lower.get("webhook-id")
    svix_ts = lower.get("svix-timestamp") or lower.get("webhook-timestamp")
    svix_sig = lower.get("svix-signature") or lower.get("webhook-signature")
    if not (svix_id and svix_ts and svix_sig):
        return False

    try:
        ts = int(svix_ts)
    except ValueError:
        return False
    if abs(time.time() - ts) > _WEBHOOK_TOLERANCE_SECONDS:
        logger.warning("clerk webhook timestamp outside tolerance")
        return False

    key = secret.split("_", 1)[1] if secret.startswith("whsec_") else secret
    try:
        key_bytes = base64.b64decode(key)
    except Exception:
        return False

    signed = f"{svix_id}.{ts}.{body.decode('utf-8')}".encode("utf-8")
    expected = base64.b64encode(hmac.new(key_bytes, signed, hashlib.sha256).digest()).decode()

    for part in svix_sig.split(" "):
        _, _, sig = part.partition(",")
        if sig and hmac.compare_digest(sig, expected):
            return True
    return False


class ClerkAdminError(Exception):
    def __init__(self, message: str, status_code: int = 502):
        super().__init__(message)
        self.status_code = status_code


async def _admin_request(method: str, path: str, json_body: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    if not settings.clerk_secret_key:
        raise ClerkAdminError("Clerk is not configured on this deployment.", 503)
    url = f"{settings.clerk_api_url.rstrip('/')}/v1{path}"
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.request(
                method,
                url,
                json=json_body,
                headers={"Authorization": f"Bearer {settings.clerk_secret_key}"},
            )
    except httpx.HTTPError as exc:
        raise ClerkAdminError(f"Clerk request failed: {exc.__class__.__name__}") from exc
    if resp.status_code >= 400:
        detail = ""
        try:
            errors = resp.json().get("errors") or []
            if errors:
                detail = errors[0].get("long_message") or errors[0].get("message") or ""
        except ValueError:
            pass
        status = resp.status_code if resp.status_code in (400, 404, 409, 422) else 502
        raise ClerkAdminError(detail or f"Clerk returned HTTP {resp.status_code}", status)
    try:
        return resp.json()
    except ValueError:
        return {}


def _org_role(role: str) -> str:
    return role if role.startswith("org:") else f"org:{role}"


async def create_org_invitation(
    clerk_org_id: str,
    email: str,
    role: str,
    inviter_clerk_user_id: Optional[str],
    redirect_url: Optional[str] = None,
) -> dict[str, Any]:
    body: dict[str, Any] = {"email_address": email, "role": _org_role(role)}
    if inviter_clerk_user_id:
        body["inviter_user_id"] = inviter_clerk_user_id
    if redirect_url:
        body["redirect_url"] = redirect_url
    return await _admin_request("POST", f"/organizations/{clerk_org_id}/invitations", body)


async def revoke_org_invitation(
    clerk_org_id: str, invitation_id: str, requesting_clerk_user_id: Optional[str]
) -> dict[str, Any]:
    body = {"requesting_user_id": requesting_clerk_user_id} if requesting_clerk_user_id else {}
    return await _admin_request(
        "POST", f"/organizations/{clerk_org_id}/invitations/{invitation_id}/revoke", body
    )


async def update_org_membership_role(clerk_org_id: str, clerk_user_id: str, role: str) -> dict[str, Any]:
    return await _admin_request(
        "PATCH",
        f"/organizations/{clerk_org_id}/memberships/{clerk_user_id}",
        {"role": _org_role(role)},
    )


async def delete_org_membership(clerk_org_id: str, clerk_user_id: str) -> dict[str, Any]:
    return await _admin_request("DELETE", f"/organizations/{clerk_org_id}/memberships/{clerk_user_id}")
