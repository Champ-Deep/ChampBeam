"""Organization endpoints: context, member roster, and consolidated analytics.

The admin (marketing) sees how content performs across every member (sales rep)
in the org. Engagement is rolled up by ``content_id`` so the same content shared
by different members via different links/files is recognized as one item and its
stats are consolidated — exactly the insight the admin wants.
"""

from __future__ import annotations

import logging
from typing import List, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import distinct, func, select, union_all
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import TokenData, require_org_admin, require_org_member
from app.db.postgres import get_db_session
from app.models.content import Content, ContentShare
from app.models.org import Organization, OrganizationMembership
from app.models.user import User
from app.models.utm import ClickEvent

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/org", tags=["Organization"])


# ============================================================================
# Schemas
# ============================================================================


class OrgContext(BaseModel):
    org_id: str
    org_slug: Optional[str]
    name: Optional[str]
    role: Optional[str]
    is_admin: bool
    member_count: int


class MemberStats(BaseModel):
    user_id: str
    email: Optional[str]
    full_name: Optional[str]
    role: str
    shares: int
    opens: int
    unique_opens: int


class ContentPerformance(BaseModel):
    content_id: str
    title: str
    kind: str
    is_archived: bool
    shares: int
    sharing_members: int
    opens: int
    unique_opens: int
    last_engaged_at: Optional[str]


class ContentPerformanceReport(BaseModel):
    total_content: int
    total_shares: int
    total_opens: int
    items: List[ContentPerformance]


class MemberContribution(BaseModel):
    user_id: str
    email: Optional[str]
    full_name: Optional[str]
    opens: int
    unique_opens: int
    share_url: Optional[str] = None


class ContentBreakdown(BaseModel):
    content_id: str
    title: str
    opens: int
    unique_opens: int
    members: List[MemberContribution]


# ============================================================================
# Helpers
# ============================================================================


async def _org(session: AsyncSession, user: TokenData) -> Organization:
    result = await session.execute(
        select(Organization).where(Organization.clerk_org_id == user.org_id)
    )
    org = result.scalar_one_or_none()
    if org is None:
        raise HTTPException(status_code=409, detail="Organization is not provisioned yet. Retry shortly.")
    return org


def _engagement_rows(org_uuid: UUID):
    """UNION ALL of (content_id, member, ip, event_id, clicked_at) engagement rows.

    Combines link clicks and file views attributed through ``content_shares`` so
    a single subquery can be grouped by content, by member, or by both — and
    distinct-IP counts stay correct across a content's link and file shares.
    """
    link_q = (
        select(
            ContentShare.content_id.label("cid"),
            ContentShare.shared_by_user_id.label("member"),
            ClickEvent.ip_address.label("ip"),
            ClickEvent.id.label("eid"),
            ClickEvent.clicked_at.label("at"),
        )
        .join(ClickEvent, ClickEvent.link_id == ContentShare.link_id)
        .where(ContentShare.organization_id == org_uuid, ContentShare.link_id.isnot(None))
    )
    file_q = (
        select(
            ContentShare.content_id.label("cid"),
            ContentShare.shared_by_user_id.label("member"),
            ClickEvent.ip_address.label("ip"),
            ClickEvent.id.label("eid"),
            ClickEvent.clicked_at.label("at"),
        )
        .join(ClickEvent, ClickEvent.file_id == ContentShare.file_id)
        .where(ContentShare.organization_id == org_uuid, ContentShare.file_id.isnot(None))
    )
    return union_all(link_q, file_q).subquery("engagement")


# ============================================================================
# Endpoints
# ============================================================================


@router.get("/context", response_model=OrgContext)
async def org_context(
    user: TokenData = Depends(require_org_member),
    session: AsyncSession = Depends(get_db_session),
):
    """The active org for the signed-in user, plus role and member count."""
    org = await _org(session, user)
    member_count = int((await session.execute(
        select(func.count(OrganizationMembership.id)).where(
            OrganizationMembership.organization_id == org.id
        )
    )).scalar() or 0)
    return OrgContext(
        org_id=user.org_id,
        org_slug=user.org_slug or org.slug,
        name=org.name,
        role=user.org_role,
        is_admin=user.is_org_admin,
        member_count=member_count,
    )


@router.get("/members", response_model=List[MemberStats])
async def list_members(
    user: TokenData = Depends(require_org_admin),
    session: AsyncSession = Depends(get_db_session),
):
    """Roster of the org's members with their sharing activity (admin only)."""
    org = await _org(session, user)

    members = (await session.execute(
        select(OrganizationMembership, User)
        .join(User, OrganizationMembership.user_id == User.id)
        .where(OrganizationMembership.organization_id == org.id)
    )).all()

    # Shares per member.
    share_counts = dict((row.member, row.n) for row in (await session.execute(
        select(
            ContentShare.shared_by_user_id.label("member"),
            func.count(ContentShare.id).label("n"),
        )
        .where(ContentShare.organization_id == org.id)
        .group_by(ContentShare.shared_by_user_id)
    )).all())

    # Opens / unique opens per member.
    eng = _engagement_rows(org.id)
    opens_by_member = {
        row.member: (row.opens, row.uniq)
        for row in (await session.execute(
            select(
                eng.c.member.label("member"),
                func.count(eng.c.eid).label("opens"),
                func.count(distinct(eng.c.ip)).label("uniq"),
            ).group_by(eng.c.member)
        )).all()
    }

    out: list[MemberStats] = []
    for membership, u in members:
        opens, uniq = opens_by_member.get(u.id, (0, 0))
        out.append(MemberStats(
            user_id=str(u.id),
            email=None if user_service_is_placeholder(u.email) else u.email,
            full_name=u.full_name,
            role=membership.role,
            shares=int(share_counts.get(u.id, 0)),
            opens=int(opens or 0),
            unique_opens=int(uniq or 0),
        ))
    out.sort(key=lambda m: m.opens, reverse=True)
    return out


@router.get("/analytics/content", response_model=ContentPerformanceReport)
async def content_performance(
    user: TokenData = Depends(require_org_admin),
    session: AsyncSession = Depends(get_db_session),
):
    """Consolidated per-content performance across all members (admin only)."""
    org = await _org(session, user)

    contents = (await session.execute(
        select(Content).where(Content.organization_id == org.id)
    )).scalars().all()
    if not contents:
        return ContentPerformanceReport(total_content=0, total_shares=0, total_opens=0, items=[])

    # shares + distinct sharing members per content.
    share_agg = {
        row.cid: (row.shares, row.members)
        for row in (await session.execute(
            select(
                ContentShare.content_id.label("cid"),
                func.count(ContentShare.id).label("shares"),
                func.count(distinct(ContentShare.shared_by_user_id)).label("members"),
            )
            .where(ContentShare.organization_id == org.id)
            .group_by(ContentShare.content_id)
        )).all()
    }

    eng = _engagement_rows(org.id)
    opens_agg = {
        row.cid: (row.opens, row.uniq, row.last_at)
        for row in (await session.execute(
            select(
                eng.c.cid.label("cid"),
                func.count(eng.c.eid).label("opens"),
                func.count(distinct(eng.c.ip)).label("uniq"),
                func.max(eng.c.at).label("last_at"),
            ).group_by(eng.c.cid)
        )).all()
    }

    items: list[ContentPerformance] = []
    total_shares = total_opens = 0
    for c in contents:
        shares, members = share_agg.get(c.id, (0, 0))
        opens, uniq, last_at = opens_agg.get(c.id, (0, 0, None))
        total_shares += int(shares or 0)
        total_opens += int(opens or 0)
        items.append(ContentPerformance(
            content_id=str(c.id),
            title=c.title,
            kind=c.kind,
            is_archived=c.is_archived,
            shares=int(shares or 0),
            sharing_members=int(members or 0),
            opens=int(opens or 0),
            unique_opens=int(uniq or 0),
            last_engaged_at=last_at.isoformat() if last_at else None,
        ))
    items.sort(key=lambda i: i.opens, reverse=True)
    return ContentPerformanceReport(
        total_content=len(contents),
        total_shares=total_shares,
        total_opens=total_opens,
        items=items,
    )


@router.get("/analytics/content/{content_id}", response_model=ContentBreakdown)
async def content_member_breakdown(
    content_id: str,
    user: TokenData = Depends(require_org_admin),
    session: AsyncSession = Depends(get_db_session),
):
    """Per-member breakdown for one content item (who shared it, how it did)."""
    org = await _org(session, user)
    try:
        cid = UUID(content_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid content id.")
    content = (await session.execute(
        select(Content).where(Content.id == cid, Content.organization_id == org.id)
    )).scalar_one_or_none()
    if content is None:
        raise HTTPException(status_code=404, detail="Content not found.")

    eng = _engagement_rows(org.id)
    rows = (await session.execute(
        select(
            eng.c.member.label("member"),
            func.count(eng.c.eid).label("opens"),
            func.count(distinct(eng.c.ip)).label("uniq"),
        )
        .where(eng.c.cid == cid)
        .group_by(eng.c.member)
    )).all()

    # Resolve member identities for the contributors.
    member_ids = [r.member for r in rows]
    users = {}
    if member_ids:
        for u in (await session.execute(select(User).where(User.id.in_(member_ids)))).scalars().all():
            users[u.id] = u

    members: list[MemberContribution] = []
    total_opens = total_uniq = 0
    for r in rows:
        u = users.get(r.member)
        total_opens += int(r.opens or 0)
        total_uniq += int(r.uniq or 0)
        members.append(MemberContribution(
            user_id=str(r.member),
            email=None if (u and user_service_is_placeholder(u.email)) else (u.email if u else None),
            full_name=u.full_name if u else None,
            opens=int(r.opens or 0),
            unique_opens=int(r.uniq or 0),
        ))
    members.sort(key=lambda m: m.opens, reverse=True)
    return ContentBreakdown(
        content_id=str(content.id),
        title=content.title,
        opens=total_opens,
        unique_opens=total_uniq,
        members=members,
    )


def user_service_is_placeholder(email: Optional[str]) -> bool:
    return bool(email) and email.endswith("@clerk.placeholder")
