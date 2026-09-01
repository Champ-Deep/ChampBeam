"""Beam State: per-page comment stream, key-value state, and typed page events.

A JSON store with a comment stream, not a database product: no queries, no
per-user auth, no schemas. Pages needing more bring their own backend.
"""

from __future__ import annotations

from datetime import datetime
from uuid import uuid4

from sqlalchemy import JSON, Column, DateTime, ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID

from app.db.postgres import Base

EVENT_COMMENT_ADDED = "comment_added"
EVENT_STATE_CHANGED = "state_changed"
EVENT_GATE_FAILED = "gate_failed"


class PageComment(Base):
    __tablename__ = "page_comments"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    page_id = Column(
        UUID(as_uuid=True), ForeignKey("file_assets.id", ondelete="CASCADE"), nullable=False, index=True
    )
    author = Column(String(120), nullable=False)
    body = Column(Text, nullable=False)
    visitor_id = Column(String(64), nullable=True)
    ip = Column(String(45), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)


class PageState(Base):
    __tablename__ = "page_state"
    __table_args__ = (UniqueConstraint("page_id", "key", name="uq_page_state_page_key"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    page_id = Column(
        UUID(as_uuid=True), ForeignKey("file_assets.id", ondelete="CASCADE"), nullable=False, index=True
    )
    key = Column(String(120), nullable=False)
    # JSON with a JSONB variant for Postgres so sqlite-backed tests can build
    # the table without choking on the Postgres-specific type.
    value = Column(JSON().with_variant(JSONB(), "postgresql"), nullable=True)
    updated_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_by_visitor = Column(String(64), nullable=True)


class PageEvent(Base):
    __tablename__ = "page_events"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    page_id = Column(
        UUID(as_uuid=True), ForeignKey("file_assets.id", ondelete="CASCADE"), nullable=False, index=True
    )
    event_type = Column(String(32), nullable=False)
    ref = Column(String(160), nullable=True)
    visitor_id = Column(String(64), nullable=True)
    ip = Column(String(45), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
