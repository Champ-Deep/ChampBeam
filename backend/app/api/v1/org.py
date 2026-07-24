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

from app.core.security import (
    TokenData,
    require_org_admin,
    require_org_leader_or_admin,
    require_org_member,
)
from app.core.timeutils import iso_utc
from app.db.postgres import get_db_session
from app.models.assignment import Assignment
from app.models.content import Content, ContentShare
from app.models.org import ROLE_LEADER, Organization, OrganizationMembership
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
    leader_user_id: Optional[str] = None
    shares: int
    opens: int
    unique_opens: int


class MemberUpdate(BaseModel):
    # The leader this member reports to. Send an empty string / null to clear.
    leader_user_id: Optional[str] = None


class MemberAssignment(BaseModel):
    user_id: str
    role: str
    leader_user_id: Optional[str]


class AssignmentCreate(BaseModel):
    champvault_asset_id: str
    asset_title: Optional[str] = None
    assigned_to_user_id: str
    note: Optional[str] = None


class AssignmentResponse(BaseModel):
    id: str
    champvault_asset_id: str
    asset_title: Optional[str]
    assigned_to_user_id: str
    assigned_by_user_id: Optional[str]
    note: Optional[str]
    created_at: str
    sent: bool


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


async def _visible_member_ids(
    session: AsyncSession, org: Organization, user: TokenData
) -> Optional[set[UUID]]:
    """The member ids the caller may see in analytics.

    ``None`` means "the whole org" (super admin — no filtering). A leader sees
    only the reps assigned to them plus their own activity.
    """
    if user.is_org_admin:
        return None
    rep_ids = (await session.execute(
        select(OrganizationMembership.user_id).where(
            OrganizationMembership.organization_id == org.id,
            OrganizationMembership.leader_user_id == UUID(user.user_id),
        )
    )).scalars().all()
    return {UUID(user.user_id)} | set(rep_ids)


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
    user: TokenData = Depends(require_org_leader_or_admin),
    session: AsyncSession = Depends(get_db_session),
):
    """Roster with sharing activity. Super admin sees all; a leader sees their reps."""
    org = await _org(session, user)
    visible = await _visible_member_ids(session, org, user)

    members = (await session.execute(
        select(OrganizationMembership, User)
        .join(User, OrganizationMembership.user_id == User.id)
        .where(OrganizationMembership.organization_id == org.id)
    )).all()
    if visible is not None:
        members = [(m, u) for (m, u) in members if u.id in visible]

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
            leader_user_id=str(membership.leader_user_id) if membership.leader_user_id else None,
            shares=int(share_counts.get(u.id, 0)),
            opens=int(opens or 0),
            unique_opens=int(uniq or 0),
        ))
    out.sort(key=lambda m: m.opens, reverse=True)
    return out


@router.get("/analytics/content", response_model=ContentPerformanceReport)
async def content_performance(
    user: TokenData = Depends(require_org_leader_or_admin),
    session: AsyncSession = Depends(get_db_session),
):
    """Consolidated per-content performance. Super admin: whole org. Leader: their reps."""
    org = await _org(session, user)
    visible = await _visible_member_ids(session, org, user)

    contents = (await session.execute(
        select(Content).where(Content.organization_id == org.id)
    )).scalars().all()
    if not contents:
        return ContentPerformanceReport(total_content=0, total_shares=0, total_opens=0, items=[])

    # shares + distinct sharing members per content (scoped to visible members).
    share_stmt = (
        select(
            ContentShare.content_id.label("cid"),
            func.count(ContentShare.id).label("shares"),
            func.count(distinct(ContentShare.shared_by_user_id)).label("members"),
        )
        .where(ContentShare.organization_id == org.id)
        .group_by(ContentShare.content_id)
    )
    if visible is not None:
        share_stmt = share_stmt.where(ContentShare.shared_by_user_id.in_(visible))
    share_agg = {
        row.cid: (row.shares, row.members)
        for row in (await session.execute(share_stmt)).all()
    }

    eng = _engagement_rows(org.id)
    opens_stmt = select(
        eng.c.cid.label("cid"),
        func.count(eng.c.eid).label("opens"),
        func.count(distinct(eng.c.ip)).label("uniq"),
        func.max(eng.c.at).label("last_at"),
    ).group_by(eng.c.cid)
    if visible is not None:
        opens_stmt = opens_stmt.where(eng.c.member.in_(visible))
    opens_agg = {
        row.cid: (row.opens, row.uniq, row.last_at)
        for row in (await session.execute(opens_stmt)).all()
    }

    # A leader only sees content their reps have actually shared; a super admin
    # sees the whole library.
    if visible is not None:
        contents = [c for c in contents if c.id in share_agg]

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
            last_engaged_at=iso_utc(last_at),
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
    user: TokenData = Depends(require_org_leader_or_admin),
    session: AsyncSession = Depends(get_db_session),
):
    """Per-member breakdown for one content item. Leaders see only their reps."""
    org = await _org(session, user)
    visible = await _visible_member_ids(session, org, user)
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
    breakdown_stmt = (
        select(
            eng.c.member.label("member"),
            func.count(eng.c.eid).label("opens"),
            func.count(distinct(eng.c.ip)).label("uniq"),
        )
        .where(eng.c.cid == cid)
        .group_by(eng.c.member)
    )
    if visible is not None:
        breakdown_stmt = breakdown_stmt.where(eng.c.member.in_(visible))
    rows = (await session.execute(breakdown_stmt)).all()

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


@router.patch("/members/{user_id}", response_model=MemberAssignment)
async def assign_member_leader(
    user_id: str,
    data: MemberUpdate,
    user: TokenData = Depends(require_org_admin),
    session: AsyncSession = Depends(get_db_session),
):
    """Assign (or clear) the leader a member reports to (super admin only)."""
    org = await _org(session, user)
    try:
        member_uuid = UUID(user_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid user id.")

    membership = (await session.execute(
        select(OrganizationMembership).where(
            OrganizationMembership.organization_id == org.id,
            OrganizationMembership.user_id == member_uuid,
        )
    )).scalar_one_or_none()
    if membership is None:
        raise HTTPException(status_code=404, detail="Member not found in this org.")

    leader_uuid: Optional[UUID] = None
    if data.leader_user_id:  # empty string / null clears the assignment
        try:
            leader_uuid = UUID(data.leader_user_id)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid leader_user_id.")
        if leader_uuid == member_uuid:
            raise HTTPException(status_code=400, detail="A member cannot lead themselves.")
        leader = (await session.execute(
            select(OrganizationMembership).where(
                OrganizationMembership.organization_id == org.id,
                OrganizationMembership.user_id == leader_uuid,
            )
        )).scalar_one_or_none()
        if leader is None:
            raise HTTPException(status_code=400, detail="Leader is not a member of this org.")
        if not (leader.is_leader or leader.is_admin):
            raise HTTPException(status_code=400, detail="That member is not a leader or admin.")

    membership.leader_user_id = leader_uuid
    await session.commit()
    return MemberAssignment(
        user_id=str(member_uuid),
        role=membership.role,
        leader_user_id=str(leader_uuid) if leader_uuid else None,
    )


# ============================================================================
# Assignments (leader -> rep soft recommendations)
# ============================================================================


async def _sent_lookup(
    session: AsyncSession, org_id: UUID, assignments: list[Assignment]
) -> dict[UUID, bool]:
    """Map assignment id -> whether the assignee has since sent that asset.

    "Sent" = the rep has a ContentShare of the org's shadow Content for the
    asset. Computed in two set-based queries rather than per-row.
    """
    if not assignments:
        return {}
    asset_ids = {a.champvault_asset_id for a in assignments}
    content_by_asset = {
        asset: cid
        for cid, asset in (await session.execute(
            select(Content.id, Content.champvault_asset_id).where(
                Content.organization_id == org_id,
                Content.champvault_asset_id.in_(asset_ids),
            )
        )).all()
    }
    shares: set[tuple[UUID, UUID]] = set()
    cids = list(content_by_asset.values())
    if cids:
        shares = {
            (cid, uid)
            for cid, uid in (await session.execute(
                select(ContentShare.content_id, ContentShare.shared_by_user_id).where(
                    ContentShare.content_id.in_(cids)
                )
            )).all()
        }
    out: dict[UUID, bool] = {}
    for a in assignments:
        cid = content_by_asset.get(a.champvault_asset_id)
        out[a.id] = bool(cid and (cid, a.assigned_to_user_id) in shares)
    return out


def _assignment_response(a: Assignment, sent: bool) -> AssignmentResponse:
    return AssignmentResponse(
        id=str(a.id),
        champvault_asset_id=a.champvault_asset_id,
        asset_title=a.asset_title,
        assigned_to_user_id=str(a.assigned_to_user_id),
        assigned_by_user_id=str(a.assigned_by_user_id) if a.assigned_by_user_id else None,
        note=a.note,
        created_at=iso_utc(a.created_at) or "",
        sent=sent,
    )


@router.post("/assignments", response_model=AssignmentResponse, status_code=201)
async def create_assignment(
    data: AssignmentCreate,
    user: TokenData = Depends(require_org_leader_or_admin),
    session: AsyncSession = Depends(get_db_session),
):
    """Recommend a ChampVault asset to a rep (leader → their reps; admin → anyone).

    Idempotent per (org, asset, rep): re-assigning refreshes the note/title.
    """
    org = await _org(session, user)
    try:
        assignee = UUID(data.assigned_to_user_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid assigned_to_user_id.")

    membership = (await session.execute(
        select(OrganizationMembership).where(
            OrganizationMembership.organization_id == org.id,
            OrganizationMembership.user_id == assignee,
        )
    )).scalar_one_or_none()
    if membership is None:
        raise HTTPException(status_code=400, detail="Assignee is not a member of this org.")
    # A leader may only assign to their own reps; a super admin may assign to anyone.
    if not user.is_org_admin and membership.leader_user_id != UUID(user.user_id):
        raise HTTPException(status_code=403, detail="You can only assign to your own reps.")

    existing = (await session.execute(
        select(Assignment).where(
            Assignment.organization_id == org.id,
            Assignment.champvault_asset_id == data.champvault_asset_id,
            Assignment.assigned_to_user_id == assignee,
        )
    )).scalar_one_or_none()
    if existing is not None:
        existing.note = data.note
        if data.asset_title:
            existing.asset_title = data.asset_title
        assignment = existing
    else:
        assignment = Assignment(
            organization_id=org.id,
            champvault_asset_id=data.champvault_asset_id,
            asset_title=data.asset_title,
            assigned_to_user_id=assignee,
            assigned_by_user_id=UUID(user.user_id),
            note=data.note,
        )
        session.add(assignment)
    await session.commit()
    await session.refresh(assignment)
    sent = await _sent_lookup(session, org.id, [assignment])
    return _assignment_response(assignment, sent.get(assignment.id, False))


@router.get("/assignments/mine", response_model=List[AssignmentResponse])
async def my_assignments(
    user: TokenData = Depends(require_org_member),
    session: AsyncSession = Depends(get_db_session),
):
    """The assets a leader has recommended to the caller, with sent status."""
    org = await _org(session, user)
    rows = (await session.execute(
        select(Assignment)
        .where(
            Assignment.organization_id == org.id,
            Assignment.assigned_to_user_id == UUID(user.user_id),
        )
        .order_by(Assignment.created_at.desc())
    )).scalars().all()
    sent = await _sent_lookup(session, org.id, list(rows))
    return [_assignment_response(a, sent.get(a.id, False)) for a in rows]


@router.get("/assignments", response_model=List[AssignmentResponse])
async def list_assignments(
    user: TokenData = Depends(require_org_leader_or_admin),
    session: AsyncSession = Depends(get_db_session),
):
    """Assignments the caller made (leader) or every one in the org (super admin)."""
    org = await _org(session, user)
    stmt = select(Assignment).where(Assignment.organization_id == org.id)
    if not user.is_org_admin:
        stmt = stmt.where(Assignment.assigned_by_user_id == UUID(user.user_id))
    rows = (await session.execute(stmt.order_by(Assignment.created_at.desc()))).scalars().all()
    sent = await _sent_lookup(session, org.id, list(rows))
    return [_assignment_response(a, sent.get(a.id, False)) for a in rows]


@router.delete("/assignments/{assignment_id}", status_code=204)
async def delete_assignment(
    assignment_id: str,
    user: TokenData = Depends(require_org_leader_or_admin),
    session: AsyncSession = Depends(get_db_session),
):
    """Withdraw an assignment (leader: only their own; super admin: any in org)."""
    org = await _org(session, user)
    try:
        aid = UUID(assignment_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid assignment id.")
    assignment = (await session.execute(
        select(Assignment).where(
            Assignment.id == aid,
            Assignment.organization_id == org.id,
        )
    )).scalar_one_or_none()
    if assignment is None:
        raise HTTPException(status_code=404, detail="Assignment not found.")
    if not user.is_org_admin and assignment.assigned_by_user_id != UUID(user.user_id):
        raise HTTPException(status_code=403, detail="You can only withdraw your own assignments.")
    await session.delete(assignment)
    await session.commit()


def user_service_is_placeholder(email: Optional[str]) -> bool:
    return bool(email) and email.endswith("@clerk.placeholder")
