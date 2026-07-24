"""Hosted Briefing Rooms + identified visit tracking (functional spec Modules B & C).

Authenticated, org-scoped endpoints let a BD rep assemble a room from ChampVault
assets, add recipients (each minted a unique tokenized link), and read a
self-ranking engagement dashboard. Two **public** endpoints (no auth) back the
hosted page: resolve a room+token for rendering, and ingest engagement events.
"""

from __future__ import annotations

import logging
from typing import Any, List, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import TokenData, require_org_member
from app.core.timeutils import iso_utc
from app.db.postgres import get_db_session
from app.models.room import (
    EVENT_TYPES,
    ROOM_ARCHIVED,
    ROOM_PUBLISHED,
    Room,
    RoomEvent,
    RoomLink,
    RoomRecipient,
)
from app.services import org_service, room_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/rooms", tags=["Briefing Rooms"])


# ============================================================================
# Schemas
# ============================================================================


class RoomCreate(BaseModel):
    title: str = Field(..., min_length=1, max_length=255)
    bucket: Optional[str] = Field(default=None, max_length=80)
    asset_ids: list[str] = Field(default_factory=list)
    personalization: dict[str, Any] = Field(default_factory=dict)


class RoomUpdate(BaseModel):
    title: Optional[str] = Field(default=None, max_length=255)
    bucket: Optional[str] = Field(default=None, max_length=80)
    asset_ids: Optional[list[str]] = None
    personalization: Optional[dict[str, Any]] = None


class RoomResponse(BaseModel):
    id: str
    title: str
    slug: str
    bucket: Optional[str]
    state: str
    asset_ids: list[str]
    personalization: dict[str, Any]
    recipient_count: int
    created_at: str


class RecipientCreate(BaseModel):
    name: Optional[str] = Field(default=None, max_length=255)
    company: Optional[str] = Field(default=None, max_length=255)
    email: Optional[str] = Field(default=None, max_length=320)
    bucket: Optional[str] = Field(default=None, max_length=80)


class RecipientResponse(BaseModel):
    id: str
    name: Optional[str]
    company: Optional[str]
    email: Optional[str]
    bucket: Optional[str]
    token: str
    url: str


class TrackRequest(BaseModel):
    slug: str
    type: str
    token: Optional[str] = None
    session_id: Optional[str] = Field(default=None, max_length=64)
    payload: dict[str, Any] = Field(default_factory=dict)


class PublicRoomResponse(BaseModel):
    slug: str
    title: str
    state: str
    ended: bool  # archived rooms render a branded "briefing has ended" page
    asset_ids: list[str]
    personalization: dict[str, str]
    identified: bool  # True when a valid token resolved to a named recipient


class RecipientEngagement(BaseModel):
    recipient_id: str
    name: Optional[str]
    company: Optional[str]
    email: Optional[str]
    score: int
    events: int
    last_engaged_at: Optional[str]


class RoomAnalytics(BaseModel):
    room_id: str
    title: str
    recipients: list[RecipientEngagement]
    # Forwarded / unknown viewers (events with no token) — a signal, surfaced.
    anonymous_events: int
    anonymous_sessions: int


# ============================================================================
# Helpers
# ============================================================================


async def _org_uuid(session: AsyncSession, user: TokenData) -> UUID:
    org_uuid = await org_service.resolve_org_uuid(session, user.org_id)
    if org_uuid is None:
        raise HTTPException(status_code=409, detail="Organization is not provisioned yet. Retry shortly.")
    return org_uuid


async def _recipient_count(session: AsyncSession, room_id: UUID) -> int:
    return int((await session.execute(
        select(func.count(RoomRecipient.id)).where(RoomRecipient.room_id == room_id)
    )).scalar() or 0)


def _room_response(room: Room, recipient_count: int) -> RoomResponse:
    return RoomResponse(
        id=str(room.id),
        title=room.title,
        slug=room.slug,
        bucket=room.bucket,
        state=room.state,
        asset_ids=list(room.asset_ids or []),
        personalization=dict(room.personalization or {}),
        recipient_count=recipient_count,
        created_at=iso_utc(room.created_at) or "",
    )


def _client_ip(request: Request) -> Optional[str]:
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else None


# ============================================================================
# Authenticated (org-scoped) endpoints
# ============================================================================


@router.post("", response_model=RoomResponse, status_code=201)
async def create_room(
    data: RoomCreate,
    user: TokenData = Depends(require_org_member),
    session: AsyncSession = Depends(get_db_session),
):
    org_uuid = await _org_uuid(session, user)
    room = await room_service.create_room(
        session,
        org_uuid=org_uuid,
        owner_user_id=user.user_id,
        title=data.title,
        bucket=data.bucket,
        asset_ids=data.asset_ids,
        personalization=data.personalization,
    )
    await session.commit()
    return _room_response(room, 0)


@router.get("", response_model=List[RoomResponse])
async def list_rooms(
    user: TokenData = Depends(require_org_member),
    session: AsyncSession = Depends(get_db_session),
):
    org_uuid = await _org_uuid(session, user)
    rows = (await session.execute(
        select(Room).where(Room.organization_id == org_uuid).order_by(Room.created_at.desc())
    )).scalars().all()
    return [_room_response(r, await _recipient_count(session, r.id)) for r in rows]


@router.get("/{room_id}", response_model=RoomResponse)
async def get_room(
    room_id: str,
    user: TokenData = Depends(require_org_member),
    session: AsyncSession = Depends(get_db_session),
):
    org_uuid = await _org_uuid(session, user)
    room = await room_service.get_org_room(session, room_id, org_uuid)
    return _room_response(room, await _recipient_count(session, room.id))


@router.patch("/{room_id}", response_model=RoomResponse)
async def update_room(
    room_id: str,
    data: RoomUpdate,
    user: TokenData = Depends(require_org_member),
    session: AsyncSession = Depends(get_db_session),
):
    org_uuid = await _org_uuid(session, user)
    room = await room_service.get_org_room(session, room_id, org_uuid)
    if data.title is not None:
        room.title = data.title
    if data.bucket is not None:
        room.bucket = data.bucket
    if data.asset_ids is not None:
        room.asset_ids = list(data.asset_ids)
    if data.personalization is not None:
        room.personalization = dict(data.personalization)
    await session.commit()
    return _room_response(room, await _recipient_count(session, room.id))


@router.post("/{room_id}/publish", response_model=RoomResponse)
async def publish_room(
    room_id: str,
    user: TokenData = Depends(require_org_member),
    session: AsyncSession = Depends(get_db_session),
):
    org_uuid = await _org_uuid(session, user)
    room = await room_service.get_org_room(session, room_id, org_uuid)
    await room_service.publish_room(session, room)
    await session.commit()
    return _room_response(room, await _recipient_count(session, room.id))


@router.post("/{room_id}/archive", response_model=RoomResponse)
async def archive_room(
    room_id: str,
    user: TokenData = Depends(require_org_member),
    session: AsyncSession = Depends(get_db_session),
):
    """Archive a room. Its links keep resolving, but the page shows a branded
    "this briefing has ended" state instead of the content (never a 404)."""
    org_uuid = await _org_uuid(session, user)
    room = await room_service.get_org_room(session, room_id, org_uuid)
    room.state = ROOM_ARCHIVED
    await session.commit()
    return _room_response(room, await _recipient_count(session, room.id))


@router.post("/{room_id}/recipients", response_model=RecipientResponse, status_code=201)
async def add_recipient(
    room_id: str,
    data: RecipientCreate,
    user: TokenData = Depends(require_org_member),
    session: AsyncSession = Depends(get_db_session),
):
    org_uuid = await _org_uuid(session, user)
    room = await room_service.get_org_room(session, room_id, org_uuid)
    recipient, link = await room_service.add_recipient(
        session,
        room,
        owner_user_id=user.user_id,
        name=data.name,
        company=data.company,
        email=data.email,
        bucket=data.bucket,
    )
    await session.commit()
    return RecipientResponse(
        id=str(recipient.id),
        name=recipient.name,
        company=recipient.company,
        email=recipient.email,
        bucket=recipient.bucket,
        token=link.token,
        url=room_service.room_url(room.slug, link.token),
    )


@router.get("/{room_id}/analytics", response_model=RoomAnalytics)
async def room_analytics(
    room_id: str,
    user: TokenData = Depends(require_org_member),
    session: AsyncSession = Depends(get_db_session),
):
    """Per-recipient engagement scores (self-ranking follow-up list) + the
    anonymous/forwarded-viewer signal."""
    org_uuid = await _org_uuid(session, user)
    room = await room_service.get_org_room(session, room_id, org_uuid)

    recipients = (await session.execute(
        select(RoomRecipient).where(RoomRecipient.room_id == room.id)
    )).scalars().all()

    out: list[RecipientEngagement] = []
    for r in recipients:
        events = (await session.execute(
            select(RoomEvent).where(RoomEvent.recipient_id == r.id)
        )).scalars().all()
        last = max((e.created_at for e in events), default=None)
        out.append(RecipientEngagement(
            recipient_id=str(r.id),
            name=r.name,
            company=r.company,
            email=r.email,
            score=room_service.compute_score(events),
            events=len(events),
            last_engaged_at=iso_utc(last) if last else None,
        ))
    out.sort(key=lambda e: e.score, reverse=True)  # self-ranking

    anon = (await session.execute(
        select(RoomEvent).where(RoomEvent.room_id == room.id, RoomEvent.link_id.is_(None))
    )).scalars().all()

    return RoomAnalytics(
        room_id=str(room.id),
        title=room.title,
        recipients=out,
        anonymous_events=len(anon),
        anonymous_sessions=len({e.session_id for e in anon if e.session_id}),
    )


# ============================================================================
# Public endpoints (no auth) — back the hosted page
# ============================================================================


@router.get("/public/{slug}", response_model=PublicRoomResponse)
async def public_room(
    slug: str,
    t: Optional[str] = None,
    session: AsyncSession = Depends(get_db_session),
):
    """Resolve a room (and optional recipient token) for the render layer.

    Draft rooms are treated as not-found publicly; archived rooms resolve with
    ``ended=True`` so the page can show a branded "this briefing has ended"
    message instead of a 404.
    """
    room = await room_service.get_public_room(session, slug)
    if room.state not in (ROOM_PUBLISHED, ROOM_ARCHIVED):
        raise HTTPException(status_code=404, detail="Room not found.")

    recipient: RoomRecipient | None = None
    if t:
        link = (await session.execute(
            select(RoomLink).where(RoomLink.token == t)
        )).scalar_one_or_none()
        if link is not None and link.room_id == room.id and link.recipient_id:
            recipient = await session.get(RoomRecipient, link.recipient_id)

    return PublicRoomResponse(
        slug=room.slug,
        title=room.title,
        state=room.state,
        ended=(room.state == ROOM_ARCHIVED),
        asset_ids=list(room.asset_ids or []),
        personalization=room_service.render_personalization(room, recipient),
        identified=recipient is not None,
    )


@router.post("/track", status_code=204)
async def track_event(
    data: TrackRequest,
    request: Request,
    session: AsyncSession = Depends(get_db_session),
):
    """Ingest an engagement event from a hosted room (public beacon).

    Attribution: a valid ``token`` identifies the recipient; without one the
    event is recorded anonymously (forwarded/unknown viewer). Geo is stored at
    city level only (GDPR data-minimization); full IP is never persisted.
    """
    if data.type not in EVENT_TYPES:
        raise HTTPException(status_code=400, detail=f"Unknown event type '{data.type}'.")

    room = await room_service.get_public_room(session, data.slug)

    link: RoomLink | None = None
    if data.token:
        link = (await session.execute(
            select(RoomLink).where(RoomLink.token == data.token)
        )).scalar_one_or_none()
        if link is not None and link.room_id != room.id:
            link = None  # token belongs to a different room; treat as anonymous

    country = city = None
    ip = _client_ip(request)
    if ip:
        try:
            from app.services import geoip_service

            geo = await geoip_service.lookup_ip(ip)
            if geo:
                country, city = geo.get("country"), geo.get("city")
        except Exception:  # noqa: BLE001 - geo is best-effort, never blocks ingest
            logger.debug("room track: geo lookup failed", exc_info=True)

    await room_service.record_event(
        session,
        room=room,
        link=link,
        event_type=data.type,
        payload=data.payload,
        session_id=data.session_id,
        country=country,
        city=city,
    )
    await session.commit()
