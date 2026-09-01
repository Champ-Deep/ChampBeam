"""Service-key lane for trusted backend integrations (X-Service-Key).

Contract (agreed with the agent-workspace handoff spec, 2026-08-13):
- Keys are provisioned via the SERVICE_API_KEYS env ("name:key,..."), never in
  the DB, and resolve to the pre-provisioned service user
  ``service+{name}@championsmail.com`` — so minted links/content are attributed
  and org-scoped exactly like a human's.
- The key is accepted on an explicit **write-only allowlist** of routes and
  nothing else: 401 for a bad/missing key, 403 for a valid key presented on any
  non-allowlisted route (enforced by middleware before routing, in one place).
- Per-key rate limit: 60/min (publishing is human-clicked; this is generous).
"""

from __future__ import annotations

import hashlib
import logging
import re
import time
from typing import Optional

from fastapi import HTTPException, Request, status
from fastapi.responses import JSONResponse

from app.core.config import settings

logger = logging.getLogger(__name__)

SERVICE_KEY_HEADER = "X-Service-Key"
SERVICE_KEY_RATE_LIMIT_PER_MINUTE = 60
SERVICE_USER_EMAIL_TEMPLATE = "service+{name}@championsmail.com"

_UUID_RE = r"[0-9a-fA-F-]{36}"

# The complete surface a service key can touch. Write-only by design: the
# workspace publishes through ChampBeam, it never reads ChampBeam data.
_ALLOWED: list[tuple[str, re.Pattern[str]]] = [
    ("POST", re.compile(r"^/api/v1/content/?$")),
    ("POST", re.compile(rf"^/api/v1/content/{_UUID_RE}/share/?$")),
    ("POST", re.compile(r"^/api/v1/utm/generate/?$")),
    # Persistent hosted pages (checklists, dashboards) — publish + update.
    ("POST", re.compile(r"^/api/v1/pages/?$")),
    ("POST", re.compile(r"^/api/v1/pages/upload/?$")),
    ("PUT", re.compile(rf"^/api/v1/pages/{_UUID_RE}/?$")),
    ("PATCH", re.compile(rf"^/api/v1/pages/{_UUID_RE}/?$")),
]


def resolve_service_name(raw_key: str) -> Optional[str]:
    digest = hashlib.sha256(raw_key.encode()).hexdigest()
    return settings.service_key_digest_map.get(digest)


def route_allowed(method: str, path: str) -> bool:
    return any(m == method and pat.match(path) for m, pat in _ALLOWED)


async def _rate_limit(name: str) -> bool:
    """True when over the limit. Fail-open when Redis is down."""
    from app.db.redis import redis_client

    window = int(time.time() // 60)
    count = await redis_client.incr_with_ttl(f"svc_rl:{name}:{window}", ttl=60)
    return count is not None and count > SERVICE_KEY_RATE_LIMIT_PER_MINUTE


async def service_key_gate(request: Request, call_next):
    """HTTP middleware: validates and scopes any request presenting a service key.

    Runs before routing so the allowlist lives in exactly one place. Requests
    without the header pass through untouched.
    """
    raw = request.headers.get(SERVICE_KEY_HEADER)
    if not raw or not raw.strip():
        return await call_next(request)

    name = resolve_service_name(raw.strip())
    if name is None:
        return JSONResponse(status_code=401, content={"detail": "Invalid service key"})
    if not route_allowed(request.method, request.url.path):
        return JSONResponse(
            status_code=403,
            content={"detail": "Service keys are not accepted on this endpoint"},
        )
    if await _rate_limit(name):
        return JSONResponse(
            status_code=429,
            content={
                "detail": f"Service key rate limit exceeded ({SERVICE_KEY_RATE_LIMIT_PER_MINUTE} requests/minute)"
            },
        )
    return await call_next(request)


async def resolve_service_identity(raw_key: str):
    """Resolve a validated service key to its designated identity (TokenData).

    The service user must be pre-provisioned (users row + org membership); an
    unprovisioned identity is a deployment error surfaced as 401 with a log.
    """
    from sqlalchemy import select

    from app.core.security import TokenData
    from app.db.postgres import async_session_maker
    from app.models.org import Organization, OrganizationMembership
    from app.models.user import User

    name = resolve_service_name(raw_key)
    if name is None:
        raise HTTPException(status_code=401, detail="Invalid service key")

    email = SERVICE_USER_EMAIL_TEMPLATE.format(name=name)
    async with async_session_maker() as session:
        user = (
            await session.execute(select(User).where(User.email == email))
        ).scalar_one_or_none()
        if user is None or user.is_active is False:
            logger.error("service key '%s' valid but user %s is not provisioned", name, email)
            raise HTTPException(status_code=401, detail="Service identity not provisioned")

        row = (
            await session.execute(
                select(OrganizationMembership, Organization)
                .join(Organization, Organization.id == OrganizationMembership.organization_id)
                .where(OrganizationMembership.user_id == user.id)
                .limit(1)
            )
        ).first()
        org_id = org_role = org_slug = None
        if row is not None:
            membership, org = row
            org_id = org.clerk_org_id
            org_role = membership.role
            org_slug = org.slug

        return TokenData(
            user_id=str(user.id),
            email=user.email or "",
            org_id=org_id,
            org_role=org_role,
            org_slug=org_slug,
        )
