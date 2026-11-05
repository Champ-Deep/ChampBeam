from __future__ import annotations

import base64
import binascii
import csv
import hashlib
import hmac
import io
import logging
import time
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import AsyncIterator, List, Literal, NoReturn, Optional
from urllib.parse import quote
from uuid import UUID, uuid4

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1 import files as files_v1
from app.core.config import settings
from app.core.security import TokenData, require_org_member
from app.core.timeutils import iso_utc
from app.db.postgres import get_db_session
from app.middleware.rate_limit import limiter
from app.models.file_asset import (
    SERVE_STREAM,
    STATUS_ACTIVE,
    STATUS_DELETED,
    STATUS_FAILED,
    STATUS_PENDING_UPLOAD,
    FileAsset,
)
from app.models.intranet import (
    ACTOR_AGENT,
    ACTOR_HUMAN,
    ACTOR_SYSTEM,
    AGENT_JEV,
    EVENT_CHECK_FAILED,
    EVENT_SCANNED,
    SCAN_NOT_SCANNED,
    SCAN_PENDING,
    STATE_SCANNING,
    AgentBenchmark,
    EVENT_INVITE_REVOKED,
    EVENT_INVITED,
    EVENT_MEMBER_DEACTIVATED,
    EVENT_MEMBER_REACTIVATED,
    EVENT_MEMBER_UPDATED,
    EVENT_OPENED_BY_SUBMITTER,
    EVENT_SETTINGS_CHANGED,
    EVENT_SUBMITTED,
    PENDING_STATES,
    STATE_EXPIRED,
    STATE_REJECTED,
    STATE_RELEASED,
    STATE_REVOKED,
    STATE_SUBMITTED,
    DecisionLogEntry,
    OrgInvite,
    OrgReviewSettings,
    Transfer,
)
from app.models.org import ROLE_ADMIN, ROLE_MEMBER, Organization, OrganizationMembership
from app.models.user import User
from app.services import agent_benchmark, clerk_client, decision_log, review_agent, storage, transfer_service
from app.services.transfer_service import TransferError

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/intranet", tags=["Intranet"])
blob_router = APIRouter(tags=["Intranet"])
blob_router.add_api_route(
    "/files/{file_id}/blob", files_v1.upload_blob, methods=["PUT"], status_code=204
)

INTRANET_RATE_LIMIT = "60/minute"
_HEARTBEAT_SECONDS = 30
_TICKET_TTL_SECONDS = 60
_BENCHMARK_STALE_HOURS = 2


@dataclass
class Actor:
    token: TokenData
    user: User
    organization: Organization
    membership: OrganizationMembership

    @property
    def user_id(self) -> str:
        return str(self.user.id)

    @property
    def is_admin(self) -> bool:
        return self.token.is_org_admin

    @property
    def is_reviewer(self) -> bool:
        return bool(self.membership.is_reviewer)


async def require_active_member(
    token: TokenData = Depends(require_org_member),
    session: AsyncSession = Depends(get_db_session),
) -> Actor:
    return await _actor_for(session, UUID(token.user_id), token.org_id or "", token)


async def _actor_for(
    session: AsyncSession, user_id: UUID, clerk_org_id: str, token: Optional[TokenData] = None
) -> Actor:
    allowed_orgs = settings.intranet_org_id_set
    if allowed_orgs and clerk_org_id not in allowed_orgs:
        raise HTTPException(status_code=403, detail="This organization is not enabled for the intranet.")
    row = (
        await session.execute(
            select(Organization, OrganizationMembership, User)
            .join(OrganizationMembership, OrganizationMembership.organization_id == Organization.id)
            .join(User, User.id == OrganizationMembership.user_id)
            .where(Organization.clerk_org_id == clerk_org_id, User.id == user_id)
        )
    ).first()
    if row is None:
        raise HTTPException(status_code=403, detail="You have not been invited to this organization.")
    org, membership, user = row
    if membership.deactivated_at is not None or user.is_active is False:
        raise HTTPException(status_code=403, detail="Your access has been deactivated.")
    if token is None:
        token = TokenData(
            user_id=str(user.id),
            email=user.email or "",
            clerk_user_id=user.clerk_id,
            org_id=clerk_org_id,
            org_role=membership.role,
        )
    return Actor(token=token, user=user, organization=org, membership=membership)


async def require_reviewer(actor: Actor = Depends(require_active_member)) -> Actor:
    if not actor.is_reviewer:
        raise HTTPException(status_code=403, detail="This action requires the Reviewer role.")
    return actor


async def require_admin(actor: Actor = Depends(require_active_member)) -> Actor:
    if not actor.is_admin:
        raise HTTPException(status_code=403, detail="This action requires an organization admin.")
    return actor


async def require_auditor(actor: Actor = Depends(require_active_member)) -> Actor:
    if not (actor.is_admin or actor.is_reviewer):
        raise HTTPException(status_code=403, detail="The decision log is for Reviewers and Admins.")
    return actor


def _raise(exc: TransferError) -> NoReturn:
    raise HTTPException(status_code=exc.status_code, detail=str(exc))


class PersonOut(BaseModel):
    user_id: str
    email: Optional[str] = None
    full_name: Optional[str] = None


class TransferOut(BaseModel):
    id: str
    state: str
    receipt: str
    filename: Optional[str]
    size_bytes: Optional[int]
    mime_type: Optional[str]
    sha256: Optional[str]
    purpose: str
    submitter: PersonOut
    recipient: PersonOut
    requested_expires_in_days: Optional[int]
    requested_one_time: bool
    one_time: bool
    expires_at: Optional[str]
    submitted_at: Optional[str]
    agent_window_ends_at: Optional[str]
    hard_expires_at: Optional[str]
    decided_at: Optional[str]
    decided_by_type: Optional[str]
    reject_reason: Optional[str]
    released_at: Optional[str]
    first_opened_at: Optional[str]
    consumed_at: Optional[str]
    expired_at: Optional[str]
    revoked_at: Optional[str]
    age_seconds: int
    scan_status: Optional[str] = None
    scan_detail: Optional[str] = None
    reminded_at: Optional[str] = None
    escalated_at: Optional[str] = None
    escalation_reason: Optional[str] = None
    decided_by_id: Optional[str] = None
    agent_result: Optional[dict] = None
    withdrawn_at: Optional[str] = None


class UploadInit(BaseModel):
    filename: str = Field(..., min_length=1, max_length=255)
    content_type: str = Field("application/octet-stream", min_length=1, max_length=127)
    size_bytes: int = Field(..., ge=1)


class UploadInitOut(BaseModel):
    file_id: str
    upload_url: str
    headers: dict
    upload_via_backend: bool


class TransferCreate(BaseModel):
    file_id: str
    recipient_user_id: str
    purpose: str = Field(..., min_length=1, max_length=500)
    requested_expires_in_days: Optional[int] = Field(None, ge=1)
    requested_one_time: bool = False


class RevokeBody(BaseModel):
    reason: Optional[str] = Field(None, max_length=1000)


class ApproveBody(BaseModel):
    expires_in_days: Optional[int] = Field(None, ge=1)
    one_time: Optional[bool] = None
    reason: Optional[str] = Field(None, max_length=1000)


class RejectBody(BaseModel):
    reason: str = Field(..., min_length=1, max_length=1000)


class MemberOut(BaseModel):
    user_id: str
    email: Optional[str]
    full_name: Optional[str]
    role: str
    is_admin: bool
    is_reviewer: bool
    active: bool


class MemberPatch(BaseModel):
    is_reviewer: Optional[bool] = None
    role: Optional[Literal["admin", "member"]] = None
    active: Optional[bool] = None


class InviteCreate(BaseModel):
    email: str = Field(..., min_length=3, max_length=320, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    role: Literal["admin", "member"] = "member"


class InviteOut(BaseModel):
    id: str
    email: str
    role: str
    status: str
    created_at: Optional[str]
    expires_at: Optional[str]


class ReviewSettingsOut(BaseModel):
    agent_mode: str
    agent_window_hours: int
    agent_threshold: float
    agent_input_mode: str
    default_expiry_days: int
    hard_expiry_days: int
    reminder_hours: Optional[int]


class ReviewSettingsPatch(BaseModel):
    agent_mode: Optional[Literal["off", "local", "jev"]] = None
    agent_window_hours: Optional[int] = Field(None, ge=1, le=24 * 14)
    agent_threshold: Optional[float] = Field(None, ge=0.5, le=1.0)
    agent_input_mode: Optional[Literal["metadata_only", "content_excerpt"]] = None
    default_expiry_days: Optional[int] = Field(None, ge=1)
    hard_expiry_days: Optional[int] = Field(None, ge=1, le=90)
    reminder_hours: Optional[int] = Field(None, ge=1, le=24 * 7)


class LogEntryOut(BaseModel):
    id: int
    at: Optional[str]
    transfer_id: Optional[str]
    event: str
    actor_type: str
    actor_id: Optional[str]
    actor_name: Optional[str]
    reason: Optional[str]
    detail: Optional[dict]
    agent_provider: Optional[str]
    agent_model: Optional[str]
    agent_input_mode: Optional[str]
    agent_p_approve: Optional[float]
    agent_threshold: Optional[float]
    agent_input_sha256: Optional[str]
    prev_hash: Optional[str]
    row_hash: str


class LogPage(BaseModel):
    items: List[LogEntryOut]
    total: int


def _person(user: Optional[User], user_id: UUID) -> PersonOut:
    if user is None:
        return PersonOut(user_id=str(user_id))
    return PersonOut(user_id=str(user.id), email=user.email, full_name=user.full_name)


def _receipt(t: Transfer) -> str:
    if t.state == STATE_SCANNING:
        return "scanning"
    if t.state in PENDING_STATES:
        return "pending"
    if t.state == STATE_REJECTED:
        return "rejected"
    if t.state == STATE_REVOKED:
        return "revoked"
    if t.first_opened_at is not None:
        return "opened"
    if t.state == STATE_EXPIRED:
        return "expired"
    if t.state == STATE_RELEASED:
        return "not_opened"
    return t.state


async def _users(session: AsyncSession, ids: set[UUID]) -> dict[UUID, User]:
    if not ids:
        return {}
    rows = (await session.execute(select(User).where(User.id.in_(ids)))).scalars().all()
    return {u.id: u for u in rows}


async def _serialize(session: AsyncSession, transfers: list[Transfer]) -> list[TransferOut]:
    if not transfers:
        return []
    file_ids = {t.file_id for t in transfers}
    assets = {
        a.id: a
        for a in (await session.execute(select(FileAsset).where(FileAsset.id.in_(file_ids)))).scalars()
    }
    people = await _users(
        session, {t.submitter_user_id for t in transfers} | {t.recipient_user_id for t in transfers}
    )
    now = datetime.utcnow()
    out: list[TransferOut] = []
    for t in transfers:
        a = assets.get(t.file_id)
        out.append(
            TransferOut(
                id=str(t.id),
                state=t.state,
                receipt=_receipt(t),
                filename=a.filename if a else None,
                size_bytes=a.size_bytes if a else None,
                mime_type=a.mime_type if a else None,
                sha256=a.sha256 if a else None,
                purpose=t.purpose,
                submitter=_person(people.get(t.submitter_user_id), t.submitter_user_id),
                recipient=_person(people.get(t.recipient_user_id), t.recipient_user_id),
                requested_expires_in_days=t.requested_expires_in_days,
                requested_one_time=bool(t.requested_one_time),
                one_time=bool(t.one_time),
                expires_at=iso_utc(t.expires_at),
                submitted_at=iso_utc(t.submitted_at),
                agent_window_ends_at=iso_utc(t.agent_window_ends_at),
                hard_expires_at=iso_utc(t.hard_expires_at),
                decided_at=iso_utc(t.decided_at),
                decided_by_type=t.decided_by_type,
                reject_reason=t.reject_reason,
                released_at=iso_utc(t.released_at),
                first_opened_at=iso_utc(t.first_opened_at),
                consumed_at=iso_utc(t.consumed_at),
                expired_at=iso_utc(t.expired_at),
                revoked_at=iso_utc(t.revoked_at),
                age_seconds=max(0, int((now - t.submitted_at).total_seconds())) if t.submitted_at else 0,
                scan_status=t.scan_status,
                scan_detail=t.scan_detail,
                reminded_at=iso_utc(t.reminded_at),
                escalated_at=iso_utc(t.escalated_at),
                escalation_reason=t.escalation_reason,
                decided_by_id=t.decided_by_id if t.decided_by_type == ACTOR_AGENT else None,
                agent_result=t.agent_result,
                withdrawn_at=iso_utc(t.withdrawn_at),
            )
        )
    return out


async def _get_transfer(session: AsyncSession, actor: Actor, transfer_id: str) -> Transfer:
    try:
        tid = UUID(transfer_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="Transfer not found.")
    transfer = await session.get(Transfer, tid)
    if transfer is None or transfer.organization_id != actor.organization.id:
        raise HTTPException(status_code=404, detail="Transfer not found.")
    return transfer


def _can_view(actor: Actor, t: Transfer) -> bool:
    if actor.is_reviewer or str(t.submitter_user_id) == actor.user_id:
        return True
    return str(t.recipient_user_id) == actor.user_id and t.released_at is not None


def _settings_out(row: OrgReviewSettings) -> ReviewSettingsOut:
    return ReviewSettingsOut(
        agent_mode=row.agent_mode,
        agent_window_hours=row.agent_window_hours,
        agent_threshold=row.agent_threshold,
        agent_input_mode=row.agent_input_mode,
        default_expiry_days=row.default_expiry_days,
        hard_expiry_days=row.hard_expiry_days,
        reminder_hours=row.reminder_hours,
    )


def _download_headers(asset: FileAsset) -> dict[str, str]:
    ascii_name = asset.filename.encode("ascii", "ignore").decode().replace('"', "").replace("\n", " ")[:200]
    disposition = f'attachment; filename="{ascii_name or "download"}"; filename*=UTF-8\'\'{quote(asset.filename[:255])}'
    return {
        "Content-Disposition": disposition,
        "Content-Length": str(asset.size_bytes),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": "sandbox",
    }


async def _live_asset(session: AsyncSession, transfer: Transfer) -> FileAsset:
    asset = await session.get(FileAsset, transfer.file_id)
    if asset is None or asset.status != STATUS_ACTIVE:
        raise HTTPException(status_code=410, detail="This file is no longer stored.")
    return asset


def _plain_stream(storage_key: str) -> AsyncIterator[bytes]:
    return storage.stream_object(storage_key)


async def _claimed_stream(
    storage_key: str, claim: transfer_service.DownloadClaim, recipient_id: str
) -> AsyncIterator[bytes]:
    from app.db import postgres

    completed = False
    try:
        last_beat = time.monotonic()
        async for chunk in storage.stream_object(storage_key):
            yield chunk
            if claim.one_time and time.monotonic() - last_beat > _HEARTBEAT_SECONDS:
                async with postgres.async_session_maker() as s:
                    alive = await transfer_service.heartbeat_claim(s, claim)
                if not alive:
                    return
                last_beat = time.monotonic()
        completed = True
    finally:
        key = None
        try:
            async with postgres.async_session_maker() as s:
                if completed:
                    key = await transfer_service.complete_download(s, claim, recipient_id)
                else:
                    await transfer_service.release_claim(s, claim)
        except Exception:
            logger.exception("intranet: finishing download failed for transfer=%s", claim.transfer_id)
        await transfer_service.delete_blob(key)


async def _compute_sha256(file_id: UUID, storage_key: str) -> None:
    from app.db import postgres

    try:
        h = hashlib.sha256()
        async for chunk in storage.stream_object(storage_key):
            h.update(chunk)
        async with postgres.async_session_maker() as s:
            asset = await s.get(FileAsset, file_id)
            if asset is not None and asset.storage_key == storage_key:
                asset.sha256 = h.hexdigest()
                await s.commit()
    except Exception:
        logger.exception("intranet: sha256 failed for file=%s", file_id)


@router.get("/me")
async def me(actor: Actor = Depends(require_active_member), session: AsyncSession = Depends(get_db_session)):
    review = await transfer_service.get_review_settings(session, actor.organization.id)
    return {
        "user": {"user_id": actor.user_id, "email": actor.user.email, "full_name": actor.user.full_name},
        "organization": {
            "id": str(actor.organization.id),
            "name": actor.organization.name,
            "slug": actor.organization.slug,
        },
        "is_admin": actor.is_admin,
        "is_reviewer": actor.is_reviewer,
        "settings": _settings_out(review).model_dump(),
        "limits": {
            "max_file_bytes": settings.intranet_max_file_bytes,
            "max_bytes_per_user": settings.max_bytes_per_user,
            "max_expiry_days": settings.intranet_max_expiry_days,
            "blocked_extensions": sorted(settings.intranet_blocked_extension_set),
        },
        "malware_scan": settings.clamd_configured,
        "malware_scan_max_bytes": settings.clamd_max_stream_bytes if settings.clamd_configured else None,
        "agent": {
            "modes": review_agent.available_modes(),
            "clef_configured": settings.clef_configured,
            "benchmark_providers": _benchmark_providers(),
        },
    }


def _benchmark_providers() -> list[str]:
    providers = []
    if settings.clef_configured:
        providers.append(review_agent.PROVIDER_CLEF)
    if settings.review_agent_allow_mock:
        providers.append(review_agent.PROVIDER_MOCK)
    return providers


@router.get("/badges")
async def badges(actor: Actor = Depends(require_active_member), session: AsyncSession = Depends(get_db_session)):
    org_id = actor.organization.id
    inbox = (
        await session.execute(
            select(func.count(Transfer.id)).where(
                Transfer.organization_id == org_id,
                Transfer.recipient_user_id == actor.user.id,
                Transfer.state == STATE_RELEASED,
                Transfer.first_opened_at.is_(None),
            )
        )
    ).scalar_one()
    queue = 0
    overdue = 0
    if actor.is_reviewer:
        pending = (
            Transfer.organization_id == org_id,
            Transfer.state.in_(PENDING_STATES),
            Transfer.submitter_user_id != actor.user.id,
        )
        queue = (await session.execute(select(func.count(Transfer.id)).where(*pending))).scalar_one()
        overdue = (
            await session.execute(
                select(func.count(Transfer.id)).where(
                    *pending,
                    or_(Transfer.reminded_at.is_not(None), Transfer.escalated_at.is_not(None)),
                )
            )
        ).scalar_one()
    return {"inbox_unopened": inbox, "review_queue": queue, "review_overdue": overdue}


@router.get("/members", response_model=List[MemberOut])
async def list_members(actor: Actor = Depends(require_active_member), session: AsyncSession = Depends(get_db_session)):
    stmt = (
        select(OrganizationMembership, User)
        .join(User, User.id == OrganizationMembership.user_id)
        .where(OrganizationMembership.organization_id == actor.organization.id)
        .order_by(User.full_name, User.email)
    )
    if not actor.is_admin:
        stmt = stmt.where(OrganizationMembership.deactivated_at.is_(None))
    rows = (await session.execute(stmt)).all()
    return [
        MemberOut(
            user_id=str(u.id),
            email=u.email,
            full_name=u.full_name,
            role=m.role,
            is_admin=m.is_admin,
            is_reviewer=bool(m.is_reviewer),
            active=m.deactivated_at is None and u.is_active is not False,
        )
        for m, u in rows
    ]


@router.patch("/members/{user_id}", response_model=MemberOut)
async def update_member(
    user_id: str,
    data: MemberPatch,
    actor: Actor = Depends(require_admin),
    session: AsyncSession = Depends(get_db_session),
):
    try:
        uid = UUID(user_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="Member not found.")
    row = (
        await session.execute(
            select(OrganizationMembership, User)
            .join(User, User.id == OrganizationMembership.user_id)
            .where(OrganizationMembership.organization_id == actor.organization.id, User.id == uid)
        )
    ).first()
    if row is None:
        raise HTTPException(status_code=404, detail="Member not found.")
    membership, user = row
    is_self = user.id == actor.user.id
    if is_self and (data.active is False or data.role == ROLE_MEMBER):
        raise HTTPException(status_code=400, detail="You cannot deactivate or demote yourself.")

    changes: dict[str, list] = {}
    if data.role is not None and data.role != (ROLE_ADMIN if membership.is_admin else ROLE_MEMBER):
        if not user.clerk_id:
            raise HTTPException(status_code=409, detail="This member has no identity record yet.")
        try:
            await clerk_client.update_org_membership_role(
                actor.organization.clerk_org_id, user.clerk_id, data.role
            )
        except clerk_client.ClerkAdminError as exc:
            raise HTTPException(status_code=exc.status_code, detail=str(exc))
        changes["role"] = [membership.role, data.role]
        membership.role = data.role
    if data.is_reviewer is not None and data.is_reviewer != bool(membership.is_reviewer):
        changes["is_reviewer"] = [bool(membership.is_reviewer), data.is_reviewer]
        membership.is_reviewer = data.is_reviewer
    event = EVENT_MEMBER_UPDATED
    if data.active is not None and data.active != (membership.deactivated_at is None):
        if data.active:
            membership.deactivated_at = None
            event = EVENT_MEMBER_REACTIVATED
        else:
            membership.deactivated_at = datetime.utcnow()
            event = EVENT_MEMBER_DEACTIVATED
            if user.clerk_id:
                try:
                    await clerk_client.delete_org_membership(actor.organization.clerk_org_id, user.clerk_id)
                except clerk_client.ClerkAdminError as exc:
                    logger.warning("intranet: Clerk membership removal failed: %s", exc)
        changes["active"] = [not data.active, data.active]
    if changes:
        await decision_log.append(
            session,
            organization_id=actor.organization.id,
            event=event,
            actor_type=ACTOR_HUMAN,
            actor_id=actor.user_id,
            detail={"member_user_id": str(user.id), "changes": changes},
        )
    await session.commit()
    return MemberOut(
        user_id=str(user.id),
        email=user.email,
        full_name=user.full_name,
        role=membership.role,
        is_admin=membership.is_admin,
        is_reviewer=bool(membership.is_reviewer),
        active=membership.deactivated_at is None and user.is_active is not False,
    )


def _invite_status(invite: OrgInvite, member_emails: set[str], now: datetime) -> str:
    if invite.email.lower() in member_emails:
        return "accepted"
    if invite.revoked_at is not None:
        return "expired" if invite.revoked_at >= invite.expires_at else "revoked"
    if invite.expires_at <= now:
        return "expired"
    return "pending"


def _invite_out(invite: OrgInvite, member_emails: set[str], now: datetime) -> InviteOut:
    return InviteOut(
        id=str(invite.id),
        email=invite.email,
        role=invite.role,
        status=_invite_status(invite, member_emails, now),
        created_at=iso_utc(invite.created_at),
        expires_at=iso_utc(invite.expires_at),
    )


async def _member_emails(session: AsyncSession, organization_id: UUID) -> set[str]:
    rows = (
        await session.execute(
            select(User.email)
            .join(OrganizationMembership, OrganizationMembership.user_id == User.id)
            .where(OrganizationMembership.organization_id == organization_id)
        )
    ).scalars()
    return {e.lower() for e in rows if e}


@router.get("/invites", response_model=List[InviteOut])
async def list_invites(actor: Actor = Depends(require_admin), session: AsyncSession = Depends(get_db_session)):
    invites = (
        await session.execute(
            select(OrgInvite)
            .where(OrgInvite.organization_id == actor.organization.id)
            .order_by(OrgInvite.created_at.desc())
            .limit(200)
        )
    ).scalars().all()
    emails = await _member_emails(session, actor.organization.id)
    now = datetime.utcnow()
    return [_invite_out(i, emails, now) for i in invites]


@router.post("/invites", response_model=InviteOut, status_code=201)
async def create_invite(
    data: InviteCreate, actor: Actor = Depends(require_admin), session: AsyncSession = Depends(get_db_session)
):
    email = data.email.strip().lower()
    emails = await _member_emails(session, actor.organization.id)
    if email in emails:
        raise HTTPException(status_code=409, detail="That person is already a member.")
    try:
        payload = await clerk_client.create_org_invitation(
            actor.organization.clerk_org_id,
            email,
            data.role,
            actor.token.clerk_user_id,
            settings.intranet_invite_redirect_url or None,
        )
    except clerk_client.ClerkAdminError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc))
    now = datetime.utcnow()
    invite = OrgInvite(
        id=uuid4(),
        organization_id=actor.organization.id,
        email=email,
        role=data.role,
        clerk_invitation_id=payload.get("id"),
        invited_by_user_id=actor.user.id,
        created_at=now,
        expires_at=now + timedelta(days=settings.intranet_invite_ttl_days),
    )
    session.add(invite)
    await session.flush()
    await decision_log.append(
        session,
        organization_id=actor.organization.id,
        event=EVENT_INVITED,
        actor_type=ACTOR_HUMAN,
        actor_id=actor.user_id,
        detail={"invite_id": str(invite.id), "role": data.role, "email_sha256": hashlib.sha256(email.encode()).hexdigest()},
    )
    await session.commit()
    return _invite_out(invite, emails, now)


@router.delete("/invites/{invite_id}", response_model=InviteOut)
async def revoke_invite(
    invite_id: str, actor: Actor = Depends(require_admin), session: AsyncSession = Depends(get_db_session)
):
    try:
        iid = UUID(invite_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="Invite not found.")
    invite = await session.get(OrgInvite, iid)
    if invite is None or invite.organization_id != actor.organization.id:
        raise HTTPException(status_code=404, detail="Invite not found.")
    now = datetime.utcnow()
    if invite.revoked_at is None:
        if invite.clerk_invitation_id:
            try:
                await clerk_client.revoke_org_invitation(
                    actor.organization.clerk_org_id, invite.clerk_invitation_id, actor.token.clerk_user_id
                )
            except clerk_client.ClerkAdminError as exc:
                if exc.status_code not in (400, 404, 409, 422):
                    raise HTTPException(status_code=exc.status_code, detail=str(exc))
        invite.revoked_at = now
        await decision_log.append(
            session,
            organization_id=actor.organization.id,
            event=EVENT_INVITE_REVOKED,
            actor_type=ACTOR_HUMAN,
            actor_id=actor.user_id,
            detail={"invite_id": str(invite.id)},
        )
        await session.commit()
    emails = await _member_emails(session, actor.organization.id)
    return _invite_out(invite, emails, now)


@router.get("/review-settings", response_model=ReviewSettingsOut)
async def get_review_settings(actor: Actor = Depends(require_active_member), session: AsyncSession = Depends(get_db_session)):
    row = await transfer_service.get_review_settings(session, actor.organization.id)
    await session.commit()
    return _settings_out(row)


@router.put("/review-settings", response_model=ReviewSettingsOut)
async def put_review_settings(
    data: ReviewSettingsPatch, actor: Actor = Depends(require_admin), session: AsyncSession = Depends(get_db_session)
):
    if data.agent_mode == AGENT_JEV:
        raise HTTPException(status_code=422, detail="The Jev provider needs IT's written sign-off and is not available yet.")
    if data.agent_mode is not None and data.agent_mode not in review_agent.available_modes():
        raise HTTPException(status_code=422, detail="The local scorer (Clef) is not configured on this deployment.")
    if data.default_expiry_days is not None and data.default_expiry_days > settings.intranet_max_expiry_days:
        raise HTTPException(
            status_code=422, detail=f"Default expiry cannot exceed {settings.intranet_max_expiry_days} days."
        )
    row = await transfer_service.get_review_settings(session, actor.organization.id)
    changes: dict[str, list] = {}
    for field, value in data.model_dump(exclude_none=True).items():
        old = getattr(row, field)
        if old != value:
            changes[field] = [old, value]
            setattr(row, field, value)
    if changes:
        row.updated_by_id = actor.user_id
        await decision_log.append(
            session,
            organization_id=actor.organization.id,
            event=EVENT_SETTINGS_CHANGED,
            actor_type=ACTOR_HUMAN,
            actor_id=actor.user_id,
            detail={"changes": changes},
        )
    await session.commit()
    return _settings_out(row)


@router.post("/uploads", response_model=UploadInitOut, status_code=201)
@limiter.limit(INTRANET_RATE_LIMIT)
async def init_upload(
    data: UploadInit,
    request: Request,
    actor: Actor = Depends(require_active_member),
    session: AsyncSession = Depends(get_db_session),
):
    files_v1._ensure_storage()
    failures = transfer_service.hard_check_failures(data.filename, data.size_bytes)
    if failures:
        await decision_log.append(
            session,
            organization_id=actor.organization.id,
            event=EVENT_CHECK_FAILED,
            actor_type=ACTOR_HUMAN,
            actor_id=actor.user_id,
            reason="; ".join(failures),
            detail={"size_bytes": data.size_bytes, "stage": "upload"},
        )
        await session.commit()
        raise HTTPException(status_code=422, detail={"message": "File failed the intake checks.", "failures": failures})
    used = await files_v1._user_storage_used(session, actor.user_id)
    if used + data.size_bytes > settings.max_bytes_per_user:
        raise HTTPException(
            status_code=402,
            detail=(
                f"Storage quota exceeded ({used // (1024 * 1024)} MB used of "
                f"{settings.max_bytes_per_user // (1024 * 1024)} MB)."
            ),
        )
    file_id = uuid4()
    key = transfer_service.INTRANET_KEY_PREFIX + files_v1._storage_key(actor.user_id, file_id, data.filename)
    try:
        upload = storage.prepare_upload(str(file_id), key, data.content_type, data.size_bytes)
    except storage.StorageNotConfigured:
        raise HTTPException(status_code=503, detail="File storage is not configured.")
    except storage.StorageError as exc:
        raise HTTPException(status_code=502, detail=f"Storage error: {exc}")
    short_code = await files_v1._allocate_unique_short_code(session, None)
    session.add(
        FileAsset(
            id=file_id,
            user_id=actor.user.id,
            short_code=short_code,
            filename=data.filename,
            kind=files_v1._classify(data.content_type),
            mime_type=data.content_type,
            size_bytes=data.size_bytes,
            storage_key=key,
            status=STATUS_PENDING_UPLOAD,
            serve_mode=SERVE_STREAM,
            view_count=0,
            created_at=datetime.utcnow(),
        )
    )
    await session.commit()
    return UploadInitOut(
        file_id=str(file_id),
        upload_url=upload["url"],
        headers=upload["headers"],
        upload_via_backend=bool(upload.get("via_backend")),
    )


@router.post("/transfers", response_model=TransferOut, status_code=201)
async def create_transfer(
    data: TransferCreate,
    background_tasks: BackgroundTasks,
    actor: Actor = Depends(require_active_member),
    session: AsyncSession = Depends(get_db_session),
):
    try:
        fid = UUID(data.file_id)
        rid = UUID(data.recipient_user_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid file or recipient id.")
    if data.requested_expires_in_days and data.requested_expires_in_days > settings.intranet_max_expiry_days:
        raise HTTPException(
            status_code=422, detail=f"Expiry cannot exceed {settings.intranet_max_expiry_days} days."
        )
    asset = await session.get(FileAsset, fid)
    if asset is None or asset.user_id != actor.user.id or asset.status == STATUS_DELETED:
        raise HTTPException(status_code=404, detail="Upload not found.")
    existing = (await session.execute(select(Transfer.id).where(Transfer.file_id == fid))).first()
    if existing is not None:
        raise HTTPException(status_code=409, detail="This upload was already submitted.")
    if rid == actor.user.id:
        raise HTTPException(status_code=400, detail="Choose a recipient other than yourself.")
    recipient = (
        await session.execute(
            select(OrganizationMembership).where(
                OrganizationMembership.organization_id == actor.organization.id,
                OrganizationMembership.user_id == rid,
                OrganizationMembership.deactivated_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if recipient is None:
        raise HTTPException(status_code=400, detail="The recipient is not an active member of this organization.")

    if asset.status in (STATUS_PENDING_UPLOAD, STATUS_FAILED):
        try:
            head = await storage.head_object(asset.storage_key)
        except storage.StorageNotConfigured:
            raise HTTPException(status_code=503, detail="File storage is not configured.")
        except storage.StorageError:
            asset.status = STATUS_FAILED
            await session.commit()
            raise HTTPException(status_code=400, detail="Upload not found in storage. Please upload again.")
        if int(head.get("size") or 0) != asset.size_bytes:
            asset.status = STATUS_FAILED
            await session.commit()
            raise HTTPException(status_code=400, detail="Uploaded size does not match the declared size.")
        asset.status = STATUS_ACTIVE

    review = await transfer_service.get_review_settings(session, actor.organization.id)
    now = datetime.utcnow()
    transfer = Transfer(
        id=uuid4(),
        organization_id=actor.organization.id,
        file_id=asset.id,
        submitter_user_id=actor.user.id,
        recipient_user_id=rid,
        purpose=data.purpose.strip(),
        state=STATE_SCANNING if settings.clamd_configured else STATE_SUBMITTED,
        requested_expires_in_days=data.requested_expires_in_days,
        requested_one_time=data.requested_one_time,
        one_time=data.requested_one_time,
        scan_status=SCAN_PENDING if settings.clamd_configured else SCAN_NOT_SCANNED,
        scan_detail=None if settings.clamd_configured else "Malware scanning is not configured.",
        check_results={
            "size": "ok",
            "type": "ok",
            "malware_scan": SCAN_PENDING if settings.clamd_configured else SCAN_NOT_SCANNED,
        },
        submitted_at=now,
        agent_window_ends_at=now + timedelta(hours=review.agent_window_hours),
        hard_expires_at=now + timedelta(days=review.hard_expiry_days),
    )
    session.add(transfer)
    await session.flush()
    await decision_log.append(
        session,
        organization_id=actor.organization.id,
        transfer_id=transfer.id,
        event=EVENT_SUBMITTED,
        actor_type=ACTOR_HUMAN,
        actor_id=actor.user_id,
        detail={
            "size_bytes": asset.size_bytes,
            "requested_expires_in_days": data.requested_expires_in_days,
            "requested_one_time": data.requested_one_time,
        },
    )
    if not settings.clamd_configured:
        await decision_log.append(
            session,
            organization_id=actor.organization.id,
            transfer_id=transfer.id,
            event=EVENT_SCANNED,
            actor_type=ACTOR_SYSTEM,
            actor_id="scanner",
            detail={"status": SCAN_NOT_SCANNED},
        )
    await session.commit()
    background_tasks.add_task(_compute_sha256, asset.id, asset.storage_key)
    if settings.clamd_configured:
        background_tasks.add_task(transfer_service.scan_transfer, transfer.id)
    return (await _serialize(session, [transfer]))[0]


@router.get("/transfers/mine", response_model=List[TransferOut])
async def my_transfers(actor: Actor = Depends(require_active_member), session: AsyncSession = Depends(get_db_session)):
    rows = (
        await session.execute(
            select(Transfer)
            .where(Transfer.organization_id == actor.organization.id, Transfer.submitter_user_id == actor.user.id)
            .order_by(Transfer.submitted_at.desc())
            .limit(500)
        )
    ).scalars().all()
    return await _serialize(session, list(rows))


@router.get("/inbox", response_model=List[TransferOut])
async def inbox(actor: Actor = Depends(require_active_member), session: AsyncSession = Depends(get_db_session)):
    rows = (
        await session.execute(
            select(Transfer)
            .where(
                Transfer.organization_id == actor.organization.id,
                Transfer.recipient_user_id == actor.user.id,
                Transfer.released_at.is_not(None),
            )
            .order_by(Transfer.released_at.desc())
            .limit(500)
        )
    ).scalars().all()
    return await _serialize(session, list(rows))


@router.get("/transfers/{transfer_id}", response_model=TransferOut)
async def get_transfer(
    transfer_id: str, actor: Actor = Depends(require_active_member), session: AsyncSession = Depends(get_db_session)
):
    transfer = await _get_transfer(session, actor, transfer_id)
    if not _can_view(actor, transfer):
        raise HTTPException(status_code=403, detail="You do not have access to this transfer.")
    return (await _serialize(session, [transfer]))[0]


@router.post("/transfers/{transfer_id}/revoke", response_model=TransferOut)
async def revoke_transfer(
    transfer_id: str,
    background_tasks: BackgroundTasks,
    body: Optional[RevokeBody] = None,
    actor: Actor = Depends(require_active_member),
    session: AsyncSession = Depends(get_db_session),
):
    transfer = await _get_transfer(session, actor, transfer_id)
    if not (actor.is_reviewer or str(transfer.submitter_user_id) == actor.user_id):
        raise HTTPException(status_code=403, detail="Only the submitter or a Reviewer can revoke.")
    try:
        key = await transfer_service.revoke(session, transfer, actor.user_id, body.reason if body else None)
    except TransferError as exc:
        _raise(exc)
    await session.commit()
    background_tasks.add_task(transfer_service.delete_blob, key)
    return (await _serialize(session, [transfer]))[0]


@router.post("/transfers/{transfer_id}/withdraw", response_model=TransferOut)
async def withdraw_transfer(
    transfer_id: str,
    background_tasks: BackgroundTasks,
    body: Optional[RevokeBody] = None,
    actor: Actor = Depends(require_active_member),
    session: AsyncSession = Depends(get_db_session),
):
    transfer = await _get_transfer(session, actor, transfer_id)
    try:
        key = await transfer_service.withdraw(session, transfer, actor.user_id, body.reason if body else None)
    except TransferError as exc:
        _raise(exc)
    await session.commit()
    background_tasks.add_task(transfer_service.delete_blob, key)
    return (await _serialize(session, [transfer]))[0]


@router.get("/transfers/{transfer_id}/download")
@limiter.limit(INTRANET_RATE_LIMIT)
async def download_transfer(
    transfer_id: str,
    request: Request,
    actor: Actor = Depends(require_active_member),
    session: AsyncSession = Depends(get_db_session),
):
    transfer = await _get_transfer(session, actor, transfer_id)
    return await _serve_transfer(session, actor, transfer)


async def _serve_transfer(session: AsyncSession, actor: Actor, transfer: Transfer) -> StreamingResponse:
    is_recipient = str(transfer.recipient_user_id) == actor.user_id
    is_submitter = str(transfer.submitter_user_id) == actor.user_id
    if is_recipient:
        try:
            claim = await transfer_service.claim_download(session, transfer, actor.user_id)
        except TransferError as exc:
            _raise(exc)
        asset = await session.get(FileAsset, transfer.file_id, populate_existing=True)
        if asset is None or asset.status != STATUS_ACTIVE:
            await transfer_service.release_claim(session, claim)
            raise HTTPException(status_code=410, detail="This file is no longer stored.")
        return StreamingResponse(
            _claimed_stream(asset.storage_key, claim, actor.user_id),
            media_type=asset.mime_type or "application/octet-stream",
            headers=_download_headers(asset),
        )
    if is_submitter:
        asset = await _live_asset(session, transfer)
        await decision_log.append(
            session,
            organization_id=transfer.organization_id,
            transfer_id=transfer.id,
            event=EVENT_OPENED_BY_SUBMITTER,
            actor_type=ACTOR_HUMAN,
            actor_id=actor.user_id,
        )
        await session.commit()
        return StreamingResponse(
            _plain_stream(asset.storage_key),
            media_type=asset.mime_type or "application/octet-stream",
            headers=_download_headers(asset),
        )
    raise HTTPException(status_code=403, detail="You do not have access to this file.")


@router.get("/review/queue", response_model=List[TransferOut])
async def review_queue(actor: Actor = Depends(require_reviewer), session: AsyncSession = Depends(get_db_session)):
    rows = (
        await session.execute(
            select(Transfer)
            .where(Transfer.organization_id == actor.organization.id, Transfer.state.in_(PENDING_STATES))
            .order_by(Transfer.submitted_at.asc())
            .limit(500)
        )
    ).scalars().all()
    return await _serialize(session, list(rows))


@router.get("/review/{transfer_id}/file")
@limiter.limit(INTRANET_RATE_LIMIT)
async def review_file(
    transfer_id: str,
    request: Request,
    actor: Actor = Depends(require_reviewer),
    session: AsyncSession = Depends(get_db_session),
):
    transfer = await _get_transfer(session, actor, transfer_id)
    return await _serve_review(session, actor, transfer)


async def _serve_review(session: AsyncSession, actor: Actor, transfer: Transfer) -> StreamingResponse:
    if not actor.is_reviewer:
        raise HTTPException(status_code=403, detail="This action requires the Reviewer role.")
    asset = await _live_asset(session, transfer)
    try:
        await transfer_service.open_for_review(session, transfer, actor.user_id)
    except TransferError as exc:
        _raise(exc)
    await session.commit()
    return StreamingResponse(
        _plain_stream(asset.storage_key),
        media_type=asset.mime_type or "application/octet-stream",
        headers=_download_headers(asset),
    )


class TicketBody(BaseModel):
    kind: Literal["transfer", "review"] = "transfer"


def _sign_ticket(payload: str) -> str:
    return hmac.new(settings.resolved_upload_secret.encode(), payload.encode(), hashlib.sha256).hexdigest()


def make_download_ticket(transfer_id: UUID, user_id: str, clerk_org_id: str, kind: str) -> str:
    expires = int(time.time()) + _TICKET_TTL_SECONDS
    payload = f"{kind}.{transfer_id}.{user_id}.{clerk_org_id}.{expires}"
    raw = f"{payload}.{_sign_ticket(payload)}".encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def read_download_ticket(ticket: str) -> Optional[tuple[str, UUID, UUID, str]]:
    try:
        padded = ticket + "=" * (-len(ticket) % 4)
        raw = base64.urlsafe_b64decode(padded.encode()).decode()
        payload, sig = raw.rsplit(".", 1)
        kind, tid, uid, org, exp = payload.split(".")
        if not hmac.compare_digest(sig, _sign_ticket(payload)):
            return None
        if int(exp) < int(time.time()):
            return None
        return kind, UUID(tid), UUID(uid), org
    except (ValueError, UnicodeDecodeError, binascii.Error):
        return None


@router.post("/transfers/{transfer_id}/download-ticket")
async def download_ticket(
    transfer_id: str,
    body: Optional[TicketBody] = None,
    actor: Actor = Depends(require_active_member),
    session: AsyncSession = Depends(get_db_session),
):
    kind = (body or TicketBody()).kind
    transfer = await _get_transfer(session, actor, transfer_id)
    if kind == "review" and not actor.is_reviewer:
        raise HTTPException(status_code=403, detail="This action requires the Reviewer role.")
    ticket = make_download_ticket(transfer.id, actor.user_id, actor.organization.clerk_org_id, kind)
    return {
        "url": f"{settings.api_v1_prefix}/intranet/download/{ticket}",
        "expires_in": _TICKET_TTL_SECONDS,
    }


@router.get("/download/{ticket}")
@limiter.limit(INTRANET_RATE_LIMIT)
async def download_with_ticket(
    ticket: str,
    request: Request,
    session: AsyncSession = Depends(get_db_session),
):
    parsed = read_download_ticket(ticket)
    if parsed is None:
        raise HTTPException(status_code=404, detail="Not found.")
    kind, tid, uid, clerk_org_id = parsed
    actor = await _actor_for(session, uid, clerk_org_id)
    transfer = await session.get(Transfer, tid)
    if transfer is None or transfer.organization_id != actor.organization.id:
        raise HTTPException(status_code=404, detail="Not found.")
    if kind == "review":
        return await _serve_review(session, actor, transfer)
    return await _serve_transfer(session, actor, transfer)


@router.get("/review/agent-approved", response_model=List[TransferOut])
async def agent_approved(actor: Actor = Depends(require_reviewer), session: AsyncSession = Depends(get_db_session)):
    rows = (
        await session.execute(
            select(Transfer)
            .where(
                Transfer.organization_id == actor.organization.id,
                Transfer.state == STATE_RELEASED,
                Transfer.decided_by_type == ACTOR_AGENT,
                Transfer.first_opened_at.is_(None),
            )
            .order_by(Transfer.released_at.desc())
            .limit(200)
        )
    ).scalars().all()
    return await _serialize(session, list(rows))


@router.post("/review/{transfer_id}/overturn", response_model=TransferOut)
async def overturn_transfer(
    transfer_id: str,
    body: RejectBody,
    background_tasks: BackgroundTasks,
    actor: Actor = Depends(require_reviewer),
    session: AsyncSession = Depends(get_db_session),
):
    transfer = await _get_transfer(session, actor, transfer_id)
    try:
        key = await transfer_service.overturn(session, transfer, actor.user_id, body.reason)
    except TransferError as exc:
        _raise(exc)
    await session.commit()
    background_tasks.add_task(transfer_service.delete_blob, key)
    return (await _serialize(session, [transfer]))[0]


class BenchmarkCreate(BaseModel):
    provider: Literal["clef", "mock"] = "clef"


def _benchmark_out(row: AgentBenchmark) -> dict:
    return {
        "id": str(row.id),
        "provider": row.provider,
        "status": row.status,
        "created_at": iso_utc(row.created_at),
        "finished_at": iso_utc(row.finished_at),
        "report": row.report,
        "markdown": agent_benchmark.to_markdown(row.report) if row.report else None,
        "error": row.error,
    }


@router.post("/agent/benchmarks", status_code=202)
async def start_benchmark(
    background_tasks: BackgroundTasks,
    body: Optional[BenchmarkCreate] = None,
    actor: Actor = Depends(require_admin),
    session: AsyncSession = Depends(get_db_session),
):
    provider = (body or BenchmarkCreate()).provider
    if provider not in _benchmark_providers():
        raise HTTPException(status_code=422, detail=f"Provider '{provider}' is not configured on this deployment.")
    running = (
        await session.execute(
            select(AgentBenchmark.id).where(
                AgentBenchmark.organization_id == actor.organization.id,
                AgentBenchmark.status == "running",
                AgentBenchmark.created_at > datetime.utcnow() - timedelta(hours=_BENCHMARK_STALE_HOURS),
            )
        )
    ).first()
    if running is not None:
        raise HTTPException(status_code=409, detail="A benchmark is already running.")
    row = AgentBenchmark(
        id=uuid4(),
        organization_id=actor.organization.id,
        provider=provider,
        status="running",
        created_at=datetime.utcnow(),
        created_by_id=actor.user_id,
    )
    session.add(row)
    await session.commit()
    background_tasks.add_task(agent_benchmark.run_job, row.id)
    return _benchmark_out(row)


@router.get("/agent/benchmarks")
async def list_benchmarks(actor: Actor = Depends(require_admin), session: AsyncSession = Depends(get_db_session)):
    rows = (
        await session.execute(
            select(AgentBenchmark)
            .where(AgentBenchmark.organization_id == actor.organization.id)
            .order_by(AgentBenchmark.created_at.desc())
            .limit(10)
        )
    ).scalars().all()
    return [_benchmark_out(r) for r in rows]


@router.post("/review/{transfer_id}/approve", response_model=TransferOut)
async def approve_transfer(
    transfer_id: str,
    body: Optional[ApproveBody] = None,
    actor: Actor = Depends(require_reviewer),
    session: AsyncSession = Depends(get_db_session),
):
    body = body or ApproveBody()
    transfer = await _get_transfer(session, actor, transfer_id)
    review = await transfer_service.get_review_settings(session, actor.organization.id)
    try:
        await transfer_service.approve(
            session, transfer, actor.user_id, review, body.expires_in_days, body.one_time, body.reason
        )
    except TransferError as exc:
        _raise(exc)
    await session.commit()
    return (await _serialize(session, [transfer]))[0]


@router.post("/review/{transfer_id}/reject", response_model=TransferOut)
async def reject_transfer(
    transfer_id: str,
    body: RejectBody,
    background_tasks: BackgroundTasks,
    actor: Actor = Depends(require_reviewer),
    session: AsyncSession = Depends(get_db_session),
):
    transfer = await _get_transfer(session, actor, transfer_id)
    try:
        key = await transfer_service.reject(session, transfer, actor.user_id, body.reason)
    except TransferError as exc:
        _raise(exc)
    await session.commit()
    background_tasks.add_task(transfer_service.delete_blob, key)
    return (await _serialize(session, [transfer]))[0]


def _log_query(
    organization_id: UUID,
    start: Optional[datetime],
    end: Optional[datetime],
    actor_id: Optional[str],
    event: Optional[str],
    transfer_id: Optional[str],
):
    stmt = select(DecisionLogEntry).where(DecisionLogEntry.organization_id == organization_id)
    if start:
        stmt = stmt.where(DecisionLogEntry.at >= start.replace(tzinfo=None))
    if end:
        stmt = stmt.where(DecisionLogEntry.at <= end.replace(tzinfo=None))
    if actor_id:
        stmt = stmt.where(DecisionLogEntry.actor_id == actor_id)
    if event:
        stmt = stmt.where(DecisionLogEntry.event.in_([e.strip() for e in event.split(",") if e.strip()]))
    if transfer_id:
        try:
            stmt = stmt.where(DecisionLogEntry.transfer_id == UUID(transfer_id))
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid transfer_id.")
    return stmt


async def _log_out(session: AsyncSession, rows: list[DecisionLogEntry]) -> list[LogEntryOut]:
    ids: set[UUID] = set()
    for r in rows:
        if r.actor_type == ACTOR_HUMAN and r.actor_id:
            try:
                ids.add(UUID(r.actor_id))
            except ValueError:
                pass
    people = await _users(session, ids)
    out = []
    for r in rows:
        name = None
        if r.actor_type == ACTOR_HUMAN and r.actor_id:
            try:
                u = people.get(UUID(r.actor_id))
            except ValueError:
                u = None
            if u:
                name = u.full_name or u.email
        else:
            name = f"{r.actor_type}:{r.agent_provider or r.actor_id}"
        out.append(
            LogEntryOut(
                id=r.id,
                at=iso_utc(r.at),
                transfer_id=str(r.transfer_id) if r.transfer_id else None,
                event=r.event,
                actor_type=r.actor_type,
                actor_id=r.actor_id,
                actor_name=name,
                reason=r.reason,
                detail=r.detail,
                agent_provider=r.agent_provider,
                agent_model=r.agent_model,
                agent_input_mode=r.agent_input_mode,
                agent_p_approve=r.agent_p_approve,
                agent_threshold=r.agent_threshold,
                agent_input_sha256=r.agent_input_sha256,
                prev_hash=r.prev_hash,
                row_hash=r.row_hash,
            )
        )
    return out


@router.get("/log", response_model=LogPage)
async def get_log(
    start: Optional[datetime] = Query(None),
    end: Optional[datetime] = Query(None),
    actor_id: Optional[str] = Query(None),
    event: Optional[str] = Query(None),
    transfer_id: Optional[str] = Query(None),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    actor: Actor = Depends(require_auditor),
    session: AsyncSession = Depends(get_db_session),
):
    stmt = _log_query(actor.organization.id, start, end, actor_id, event, transfer_id)
    total = (await session.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()
    rows = (
        await session.execute(stmt.order_by(DecisionLogEntry.id.desc()).limit(limit).offset(offset))
    ).scalars().all()
    return LogPage(items=await _log_out(session, list(rows)), total=total)


_CSV_FORMULA_PREFIXES = ("=", "+", "-", "@", chr(9), chr(13))


def _csv_cell(value) -> str:
    if value is None:
        return ""
    text = str(value)
    if text and text[0] in _CSV_FORMULA_PREFIXES:
        return "'" + text
    return text


@router.get("/log.csv")
async def get_log_csv(
    start: Optional[datetime] = Query(None),
    end: Optional[datetime] = Query(None),
    actor_id: Optional[str] = Query(None),
    event: Optional[str] = Query(None),
    transfer_id: Optional[str] = Query(None),
    actor: Actor = Depends(require_auditor),
    session: AsyncSession = Depends(get_db_session),
):
    stmt = _log_query(actor.organization.id, start, end, actor_id, event, transfer_id)
    rows = (await session.execute(stmt.order_by(DecisionLogEntry.id.asc()))).scalars().all()
    entries = await _log_out(session, list(rows))
    buf = io.StringIO()
    columns = [
        "id", "at", "transfer_id", "event", "actor_type", "actor_id", "actor_name", "reason",
        "agent_provider", "agent_model", "agent_input_mode", "agent_p_approve", "agent_threshold",
        "agent_input_sha256", "prev_hash", "row_hash",
    ]
    writer = csv.writer(buf)
    writer.writerow(columns)
    for e in entries:
        data = e.model_dump()
        writer.writerow([_csv_cell(data[c]) for c in columns])
    stamp = datetime.utcnow().strftime("%Y%m%d")
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={
            "Content-Disposition": f'attachment; filename="decision-log-{stamp}.csv"',
            "Cache-Control": "no-store",
        },
    )


@router.get("/log/verify")
async def verify_log(actor: Actor = Depends(require_auditor), session: AsyncSession = Depends(get_db_session)):
    return await decision_log.verify_chain(session, actor.organization.id)
