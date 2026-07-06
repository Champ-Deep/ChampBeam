"""Leads captured by the email gate.

When a link or file has ``require_email`` on, the viewer must submit an email
before access is granted. Each submission is stored here so the sender captures
the lead — the whole point of the gate — even if the link later self-destructs.
"""

from __future__ import annotations

from datetime import datetime
from uuid import uuid4

from sqlalchemy import Column, DateTime, ForeignKey, String
from sqlalchemy.dialects.postgresql import UUID

from app.db.postgres import Base


class AccessLead(Base):
    """One email captured at an access gate. Exactly one of link_id / file_id set."""

    __tablename__ = "access_leads"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    link_id = Column(
        UUID(as_uuid=True),
        ForeignKey("link_clicks.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    )
    file_id = Column(
        UUID(as_uuid=True),
        ForeignKey("file_assets.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    )
    email = Column(String(320), nullable=False)
    ip_address = Column(String(45), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
