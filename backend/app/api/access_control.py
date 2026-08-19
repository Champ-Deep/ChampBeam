"""Shared access-gate helpers for the redirect (/r) and file-serve (/f) paths.

Enforcement lives at serve time so a link/file self-destructs, gates on email,
or blocks VPNs regardless of how it was shared. Kept intentionally small; the
per-view counting/expiry/revoke gate for links is atomic in
``utm_service.consume_link_view``.
"""

from __future__ import annotations

import logging
import re
from typing import Optional
from uuid import UUID

from fastapi import Request

# Imported at module load (this module is imported by the redirect/file routers)
# so the table registers on Base.metadata for create_all / test schemas.
from app.models.access_lead import AccessLead  # noqa: F401

logger = logging.getLogger(__name__)

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


# Headers the CDN sets to the true visitor IP, most authoritative first.
# CF-Connecting-IP is written by Cloudflare itself on every proxied request and
# cannot be forged by the visitor, unlike X-Forwarded-For. Preferring it matters
# because a proxy chain (Cloudflare -> platform edge -> app) can leave the CDN's
# own egress IP at the front of X-Forwarded-For, which would attribute every
# open to a Cloudflare datacenter instead of the recipient.
#
# X-Real-IP is deliberately NOT consulted: our own nginx sets it to $remote_addr,
# which behind Cloudflare is the Cloudflare edge, not the visitor.
_CLIENT_IP_HEADERS = ("CF-Connecting-IP", "True-Client-IP")


def client_ip(request: Request) -> Optional[str]:
    """Best-effort true client IP, for geo enrichment and VPN gating."""
    for header in _CLIENT_IP_HEADERS:
        value = (request.headers.get(header) or "").strip()
        if value:
            return value
    forwarded = request.headers.get("X-Forwarded-For", "").split(",")[0].strip()
    if forwarded:
        return forwarded
    return request.client.host if request.client else None


def valid_email(email: Optional[str]) -> bool:
    return bool(email) and bool(_EMAIL_RE.match(email.strip())) and len(email) <= 320


# --- Email gate cookie ---------------------------------------------------
# A per-code marker set once the viewer submits an email. This is a lead-capture
# gate, not hard auth, so a simple cookie is the right weight (it just avoids
# re-prompting the same browser). Namespaced so one code can't unlock another.

def gate_cookie_name(code: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9]", "", code)[:32]
    return f"cbgate_{safe}"


def has_gate_cookie(request: Request, code: str) -> bool:
    return request.cookies.get(gate_cookie_name(code)) == "1"


async def is_vpn_ip(ip: Optional[str]) -> bool:
    """Best-effort synchronous VPN/proxy check for block_vpn links.

    Uses the same GeoIP lookup as async enrichment; on any failure we fail OPEN
    (don't block) so a lookup outage never breaks legitimate access.
    """
    if not ip:
        return False
    try:
        from app.services.geoip_service import lookup_ip
        geo = await lookup_ip(ip)
        return bool(geo and geo.get("is_vpn"))
    except Exception:
        logger.warning("is_vpn_ip lookup failed for %s", ip, exc_info=True)
        return False


async def capture_lead(
    session,
    email: str,
    *,
    ip: Optional[str],
    link_id: Optional[UUID] = None,
    file_id: Optional[UUID] = None,
) -> None:
    """Store an email captured at the gate, using the caller's request session."""
    from app.models.access_lead import AccessLead

    session.add(AccessLead(
        email=email.strip()[:320], ip_address=(ip or None), link_id=link_id, file_id=file_id,
    ))
    await session.flush()
