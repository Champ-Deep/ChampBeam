"""Hosted Briefing Rooms + identified visit tracking.

A **Room** is a standalone, personalized web page assembled from ChampVault
assets (the MVP asset source; a dedicated ChampLens adapter can slot in later
behind the same interface). Each recipient gets a **unique token** per room, so
every page view / scroll / video-progress / CTA event is attributed to a named
business contact and rolled into a single engagement score — the BD team's
self-ranking follow-up list.

    Room(1) --< RoomRecipient >-- RoomLink(token) --< RoomEvent

Anonymous events (no token — e.g. the deck was forwarded up the chain) are kept
and flagged: that's a signal, not noise.
"""

from __future__ import annotations

from datetime import datetime
from uuid import uuid4

from sqlalchemy import (
    JSON,
    Column,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship

from app.db.postgres import Base


# Room lifecycle. Archived rooms serve a branded "briefing has ended" page,
# never a 404 (see spec B2).
ROOM_DRAFT = "draft"
ROOM_PUBLISHED = "published"
ROOM_ARCHIVED = "archived"
ROOM_STATES = (ROOM_DRAFT, ROOM_PUBLISHED, ROOM_ARCHIVED)

# Event taxonomy (spec C2). Kept as plain strings so new event kinds don't need
# a migration; the score weighting decides which ones count.
EVENT_PAGE_VIEW = "page_view"
EVENT_SESSION = "session"
EVENT_SCROLL_DEPTH = "scroll_depth"
EVENT_VIDEO_PROGRESS = "video_progress"
EVENT_DOC_VIEW = "doc_view"
EVENT_DOWNLOAD = "download"
EVENT_CTA_CLICK = "cta_click"
EVENT_RETURN_VISIT = "return_visit"
EVENT_TYPES = (
    EVENT_PAGE_VIEW,
    EVENT_SESSION,
    EVENT_SCROLL_DEPTH,
    EVENT_VIDEO_PROGRESS,
    EVENT_DOC_VIEW,
    EVENT_DOWNLOAD,
    EVENT_CTA_CLICK,
    EVENT_RETURN_VISIT,
)


class Room(Base):
    """A publishable, personalized briefing page assembled from assets."""

    __tablename__ = "rooms"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    organization_id = Column(
        UUID(as_uuid=True),
        ForeignKey("organizations.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    owner_user_id = Column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )

    title = Column(String(255), nullable=False)
    # Public URL is /rooms/{slug}. Globally unique so the bare URL resolves.
    slug = Column(String(80), nullable=False, unique=True, index=True)
    # Industry bucket tag (spec: one template per bucket).
    bucket = Column(String(80), nullable=True)
    state = Column(String(16), nullable=False, default=ROOM_DRAFT)

    # Ordered ChampVault asset ids that make up the room body. Referenced by id,
    # never by file, so a new asset version flows through unless pinned (Phase 3).
    asset_ids = Column(JSON, nullable=False, default=list)
    # Personalization defaults + template hints, e.g.
    # {"prepared_for_line": "Prepared for {{company_name}}'s leadership team"}.
    personalization = Column(JSON, nullable=False, default=dict)

    published_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    recipients = relationship(
        "RoomRecipient", back_populates="room", cascade="all, delete-orphan"
    )
    links = relationship("RoomLink", back_populates="room", cascade="all, delete-orphan")


class RoomRecipient(Base):
    """A named business contact a room is prepared for."""

    __tablename__ = "room_recipients"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    room_id = Column(
        UUID(as_uuid=True),
        ForeignKey("rooms.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    organization_id = Column(
        UUID(as_uuid=True),
        ForeignKey("organizations.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    owner_user_id = Column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )

    name = Column(String(255), nullable=True)
    company = Column(String(255), nullable=True)
    email = Column(String(320), nullable=True)
    bucket = Column(String(80), nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    room = relationship("Room", back_populates="recipients")
    link = relationship(
        "RoomLink", back_populates="recipient", uselist=False, cascade="all, delete-orphan"
    )


class RoomLink(Base):
    """A unique tokenized entry point into a room for one recipient.

    The token lands in the URL (``/rooms/{slug}?t={token}``) and is also set as a
    first-party cookie so return visits via the bare URL stay identified.
    """

    __tablename__ = "room_links"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    room_id = Column(
        UUID(as_uuid=True),
        ForeignKey("rooms.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    recipient_id = Column(
        UUID(as_uuid=True),
        ForeignKey("room_recipients.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    )
    token = Column(String(64), nullable=False, unique=True, index=True)

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    expires_at = Column(DateTime, nullable=True)

    room = relationship("Room", back_populates="links")
    recipient = relationship("RoomRecipient", back_populates="link")


class RoomEvent(Base):
    """One engagement event on a room (identified when link_id is set)."""

    __tablename__ = "room_events"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    room_id = Column(
        UUID(as_uuid=True),
        ForeignKey("rooms.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # Null link/recipient = anonymous "forwarded/unknown viewer" (a signal).
    link_id = Column(
        UUID(as_uuid=True),
        ForeignKey("room_links.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    recipient_id = Column(
        UUID(as_uuid=True),
        ForeignKey("room_recipients.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    session_id = Column(String(64), nullable=True, index=True)
    type = Column(String(32), nullable=False)
    payload = Column(JSON, nullable=False, default=dict)

    # GDPR data-minimization: city-level geo only, no long-term full-IP retention.
    country = Column(String(100), nullable=True)
    city = Column(String(100), nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
