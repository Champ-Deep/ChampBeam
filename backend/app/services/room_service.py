"""Briefing-room orchestration: slugs, tokenized recipient links, event
ingestion, and engagement scoring.

Assets are referenced by ChampVault id (the MVP asset source). The room render
layer resolves those ids to signed delivery URLs at view time; this service is
purely the room/recipient/link/event spine + the self-ranking score.
"""

from __future__ import annotations

import re
import secrets
import string
from datetime import datetime
from typing import Any, Iterable, Optional
from uuid import UUID, uuid4

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.room import (
    EVENT_CTA_CLICK,
    EVENT_DOC_VIEW,
    EVENT_RETURN_VISIT,
    EVENT_SESSION,
    EVENT_VIDEO_PROGRESS,
    ROOM_ARCHIVED,
    ROOM_DRAFT,
    ROOM_PUBLISHED,
    Room,
    RoomEvent,
    RoomLink,
    RoomRecipient,
)


# Default engagement weights (spec C3). Overridable per campaign.
DEFAULT_SCORE_WEIGHTS: dict[str, int] = {
    "video": 30,      # a video watched to >= video_threshold %
    "deck": 20,       # a deck viewed to >= deck_threshold %
    "return_visit": 20,
    "cta": 20,
    "dwell": 10,      # total session dwell > dwell_threshold_s
}
VIDEO_THRESHOLD = 75
DECK_THRESHOLD = 50
DWELL_THRESHOLD_S = 180


def _slugify(title: str) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", (title or "").lower()).strip("-")
    return base[:60] or "room"


def _rand(n: int = 6) -> str:
    alphabet = string.ascii_lowercase + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(n))


def _scheme_for(host: str) -> str:
    return "http" if host.startswith(("localhost", "127.")) else "https"


def _platform_host() -> str:
    return settings.resolved_platform_redirect_host or "localhost:8000"


def room_url(slug: str, token: Optional[str] = None, *, hostname: Optional[str] = None) -> str:
    host = hostname or _platform_host()
    url = f"{_scheme_for(host)}://{host}/rooms/{slug}"
    return f"{url}?t={token}" if token else url


async def _unique_slug(session: AsyncSession, title: str) -> str:
    """A globally-unique slug derived from the title (with a random suffix on
    collision, so two 'Ferrovial Briefing' rooms don't clash)."""
    base = _slugify(title)
    for candidate in (base, *(f"{base}-{_rand()}" for _ in range(8))):
        exists = (await session.execute(
            select(Room.id).where(Room.slug == candidate)
        )).scalar_one_or_none()
        if exists is None:
            return candidate
    raise HTTPException(status_code=503, detail="Could not allocate a unique room slug.")


async def create_room(
    session: AsyncSession,
    *,
    org_uuid: UUID,
    owner_user_id: str,
    title: str,
    bucket: Optional[str],
    asset_ids: Optional[list[str]],
    personalization: Optional[dict[str, Any]],
) -> Room:
    room = Room(
        id=uuid4(),
        organization_id=org_uuid,
        owner_user_id=UUID(owner_user_id) if owner_user_id else None,
        title=title,
        slug=await _unique_slug(session, title),
        bucket=bucket,
        state=ROOM_DRAFT,
        asset_ids=list(asset_ids or []),
        personalization=dict(personalization or {}),
    )
    session.add(room)
    await session.flush()
    return room


async def get_org_room(session: AsyncSession, room_id: str, org_uuid: UUID) -> Room:
    try:
        rid = UUID(room_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid room id.")
    room = (await session.execute(
        select(Room).where(Room.id == rid, Room.organization_id == org_uuid)
    )).scalar_one_or_none()
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found.")
    return room


async def publish_room(session: AsyncSession, room: Room) -> Room:
    if room.state == ROOM_ARCHIVED:
        raise HTTPException(status_code=409, detail="Archived rooms cannot be published.")
    room.state = ROOM_PUBLISHED
    if room.published_at is None:
        room.published_at = datetime.utcnow()
    await session.flush()
    return room


async def add_recipient(
    session: AsyncSession,
    room: Room,
    *,
    owner_user_id: str,
    name: Optional[str],
    company: Optional[str],
    email: Optional[str],
    bucket: Optional[str],
) -> tuple[RoomRecipient, RoomLink]:
    """Create a recipient and mint their unique tokenized link for this room."""
    recipient = RoomRecipient(
        id=uuid4(),
        room_id=room.id,
        organization_id=room.organization_id,
        owner_user_id=UUID(owner_user_id) if owner_user_id else None,
        name=name,
        company=company,
        email=email,
        bucket=bucket or room.bucket,
    )
    session.add(recipient)
    await session.flush()
    link = await _mint_link(session, room_id=room.id, recipient_id=recipient.id)
    return recipient, link


async def _mint_link(
    session: AsyncSession, *, room_id: UUID, recipient_id: Optional[UUID]
) -> RoomLink:
    for _ in range(8):
        token = secrets.token_urlsafe(16)
        clash = (await session.execute(
            select(RoomLink.id).where(RoomLink.token == token)
        )).scalar_one_or_none()
        if clash is None:
            link = RoomLink(id=uuid4(), room_id=room_id, recipient_id=recipient_id, token=token)
            session.add(link)
            await session.flush()
            return link
    raise HTTPException(status_code=503, detail="Could not allocate a unique link token.")


async def resolve_token(
    session: AsyncSession, token: str
) -> tuple[RoomLink, RoomRecipient | None]:
    link = (await session.execute(
        select(RoomLink).where(RoomLink.token == token)
    )).scalar_one_or_none()
    if link is None:
        raise HTTPException(status_code=404, detail="Unknown link token.")
    recipient = (
        await session.get(RoomRecipient, link.recipient_id) if link.recipient_id else None
    )
    return link, recipient


async def get_public_room(session: AsyncSession, slug: str) -> Room:
    room = (await session.execute(
        select(Room).where(Room.slug == slug)
    )).scalar_one_or_none()
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found.")
    return room


def render_personalization(room: Room, recipient: RoomRecipient | None) -> dict[str, str]:
    """Resolve {{tokens}} in the room's personalization strings for a recipient.

    Unknown recipients (forwarded/anonymous) get neutral fallbacks so the page
    still renders cleanly ("Prepared for your team").
    """
    ctx = {
        "company_name": (recipient.company if recipient and recipient.company else "your team"),
        "contact_first_name": (
            (recipient.name or "").split(" ")[0] if recipient and recipient.name else "there"
        ),
        "language": (room.personalization or {}).get("language", "en"),
    }
    out: dict[str, str] = {}
    for key, template in (room.personalization or {}).items():
        if not isinstance(template, str):
            continue
        rendered = template
        for tok, val in ctx.items():
            rendered = rendered.replace("{{" + tok + "}}", str(val))
        out[key] = rendered
    # Always expose the raw context too, so the render layer can compose its own.
    out.setdefault("prepared_for_line", f"Prepared for {ctx['company_name']}")
    return out


async def record_event(
    session: AsyncSession,
    *,
    room: Room,
    link: RoomLink | None,
    event_type: str,
    payload: Optional[dict[str, Any]],
    session_id: Optional[str],
    country: Optional[str] = None,
    city: Optional[str] = None,
) -> RoomEvent:
    event = RoomEvent(
        id=uuid4(),
        room_id=room.id,
        link_id=link.id if link else None,
        recipient_id=link.recipient_id if link else None,
        session_id=session_id,
        type=event_type,
        payload=dict(payload or {}),
        country=country,
        city=city,
    )
    session.add(event)
    await session.flush()
    return event


def _percent(payload: Any) -> float:
    if not isinstance(payload, dict):
        return 0.0
    try:
        return float(payload.get("percent", 0) or 0)
    except (TypeError, ValueError):
        return 0.0


def compute_score(
    events: Iterable[RoomEvent], weights: Optional[dict[str, int]] = None
) -> int:
    """Collapse a recipient's events into a single 0–100 engagement score."""
    w = {**DEFAULT_SCORE_WEIGHTS, **(weights or {})}
    events = list(events)

    got_video = any(
        e.type == EVENT_VIDEO_PROGRESS and _percent(e.payload) >= VIDEO_THRESHOLD
        for e in events
    )
    got_deck = any(
        e.type == EVENT_DOC_VIEW and _percent(e.payload) >= DECK_THRESHOLD
        for e in events
    )
    sessions = {e.session_id for e in events if e.session_id}
    got_return = (
        len(sessions) > 1 or any(e.type == EVENT_RETURN_VISIT for e in events)
    )
    got_cta = any(e.type == EVENT_CTA_CLICK for e in events)
    total_dwell = sum(
        float((e.payload or {}).get("duration_s", 0) or 0)
        for e in events
        if e.type == EVENT_SESSION and isinstance(e.payload, dict)
    )
    got_dwell = total_dwell > DWELL_THRESHOLD_S

    score = (
        (w["video"] if got_video else 0)
        + (w["deck"] if got_deck else 0)
        + (w["return_visit"] if got_return else 0)
        + (w["cta"] if got_cta else 0)
        + (w["dwell"] if got_dwell else 0)
    )
    return max(0, min(100, int(score)))
