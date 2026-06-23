"""Shared content library for org teams.

A ``Content`` is the canonical piece an admin (the marketing team) curates: a
file (video, pitch deck, PDF) or a destination link. Team members (sales reps)
*share* it, and each share mints that member their own trackable link/file —
their own short code, optionally on their own domain — while stamping the same
``content_id``. That bridge is what lets the admin consolidate analytics: the
same content shared by different people via different links is still recognized
as one content item, and engagement rolls up by ``content_id``.

    Content(id) --< ContentShare(member, link/file) >-- ClickEvent rows
"""

from __future__ import annotations

from datetime import datetime
from uuid import uuid4

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    String,
    Text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship

from app.db.postgres import Base


CONTENT_KIND_FILE = "file"
CONTENT_KIND_LINK = "link"


class Content(Base):
    """A canonical, reshareable item in an org's content library."""

    __tablename__ = "content_items"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    organization_id = Column(
        UUID(as_uuid=True),
        ForeignKey("organizations.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # The admin who created the library item. Kept on delete so attribution
    # survives a membership being removed.
    created_by_user_id = Column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )

    title = Column(String(255), nullable=False)
    description = Column(Text, nullable=True)
    kind = Column(String(16), nullable=False)  # file | link

    # Link content: the canonical destination members share.
    canonical_url = Column(Text, nullable=True)
    # File content: the admin's master FileAsset. Member shares reuse its bytes
    # (same storage_key) under a fresh short code, so no re-upload is needed.
    file_id = Column(
        UUID(as_uuid=True),
        ForeignKey("file_assets.id", ondelete="SET NULL"),
        nullable=True,
    )

    is_archived = Column(Boolean, nullable=False, default=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    shares = relationship(
        "ContentShare",
        back_populates="content",
        cascade="all, delete-orphan",
    )


class ContentShare(Base):
    """One member's share of a library item via their own link or file.

    Exactly one of ``link_id`` / ``file_id`` is populated, mirroring the
    link-vs-file split used by ``ClickEvent``.
    """

    __tablename__ = "content_shares"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    content_id = Column(
        UUID(as_uuid=True),
        ForeignKey("content_items.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    organization_id = Column(
        UUID(as_uuid=True),
        ForeignKey("organizations.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    shared_by_user_id = Column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    link_id = Column(
        UUID(as_uuid=True),
        ForeignKey("link_clicks.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    file_id = Column(
        UUID(as_uuid=True),
        ForeignKey("file_assets.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    domain_id = Column(
        UUID(as_uuid=True),
        ForeignKey("domains.id", ondelete="SET NULL"),
        nullable=True,
    )

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    content = relationship("Content", back_populates="shares")
    shared_by = relationship("User", backref="content_shares")
