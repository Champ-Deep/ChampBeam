"""Organization mirror sync (Clerk Orgs -> local tables).

Source of truth is Clerk. These helpers keep the local ``organizations`` /
``organization_memberships`` mirror current from two inputs: the webhook
(authoritative) and the session-token claims on the auth hot path (lazy, so the
feature works before webhooks are configured). The hot-path sync is throttled
by a small in-process TTL cache so we don't write on every request.
"""

from __future__ import annotations

import logging
import time
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.org import Organization, OrganizationMembership, ROLE_MEMBER
from app.models.user import User

logger = logging.getLogger(__name__)

# (user_id, clerk_org_id) -> (role, monotonic_ts). Avoids re-upserting an
# unchanged membership on every authenticated request.
_sync_cache: dict[tuple[str, str], tuple[str, float]] = {}
_SYNC_TTL_SECONDS = 300.0


def normalize_role(raw: Optional[str]) -> str:
    """Strip Clerk's ``org:`` prefix and lowercase. Defaults to 'member'."""
    if not raw:
        return ROLE_MEMBER
    r = raw.strip()
    if r.startswith("org:"):
        r = r[4:]
    return r.lower() or ROLE_MEMBER


async def upsert_organization(
    session: AsyncSession,
    clerk_org_id: str,
    name: Optional[str] = None,
    slug: Optional[str] = None,
) -> Organization:
    result = await session.execute(
        select(Organization).where(Organization.clerk_org_id == clerk_org_id)
    )
    org = result.scalar_one_or_none()
    if org is None:
        org = Organization(clerk_org_id=clerk_org_id, name=name, slug=slug)
        session.add(org)
        await session.flush()
        return org
    if name is not None:
        org.name = name
    if slug is not None:
        org.slug = slug
    await session.flush()
    return org


async def upsert_membership(
    session: AsyncSession,
    organization_id,
    user_id,
    role: str,
    clerk_membership_id: Optional[str] = None,
) -> OrganizationMembership:
    result = await session.execute(
        select(OrganizationMembership).where(
            OrganizationMembership.organization_id == organization_id,
            OrganizationMembership.user_id == user_id,
        )
    )
    membership = result.scalar_one_or_none()
    if membership is None:
        membership = OrganizationMembership(
            organization_id=organization_id,
            user_id=user_id,
            role=role,
            clerk_membership_id=clerk_membership_id,
        )
        session.add(membership)
        await session.flush()
        return membership
    membership.role = role
    if clerk_membership_id:
        membership.clerk_membership_id = clerk_membership_id
    await session.flush()
    return membership


async def sync_from_token(
    session: AsyncSession,
    user: User,
    clerk_org_id: str,
    role: str,
    slug: Optional[str] = None,
) -> None:
    """Best-effort mirror of the active org membership from token claims.

    Throttled by the TTL cache and intentionally swallows errors: a sync hiccup
    must never block an authenticated request.
    """
    cache_key = (str(user.id), clerk_org_id)
    cached = _sync_cache.get(cache_key)
    now = time.monotonic()
    if cached and cached[0] == role and (now - cached[1]) < _SYNC_TTL_SECONDS:
        return
    try:
        org = await upsert_organization(session, clerk_org_id, slug=slug)
        await upsert_membership(session, org.id, user.id, role)
        _sync_cache[cache_key] = (role, now)
    except Exception:
        logger.warning("org sync_from_token failed for org=%s", clerk_org_id, exc_info=True)
        await session.rollback()


async def get_membership(
    session: AsyncSession, user_id, clerk_org_id: str
) -> Optional[OrganizationMembership]:
    result = await session.execute(
        select(OrganizationMembership)
        .join(Organization, OrganizationMembership.organization_id == Organization.id)
        .where(
            Organization.clerk_org_id == clerk_org_id,
            OrganizationMembership.user_id == user_id,
        )
    )
    return result.scalar_one_or_none()


async def resolve_org_uuid(session: AsyncSession, clerk_org_id: str):
    """Return the local Organization UUID for a Clerk org id, or None."""
    result = await session.execute(
        select(Organization.id).where(Organization.clerk_org_id == clerk_org_id)
    )
    return result.scalar_one_or_none()
