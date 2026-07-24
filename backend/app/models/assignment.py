"""Soft assignments: a leader recommends a library asset to one of their reps.

"Soft" means it never gates sending — the whole ChampVault library stays
sendable by anyone. An assignment just surfaces the asset on the rep's shelf and
lets the leader track whether it was actually sent. It points at a ChampVault
asset id (plus a title snapshot so the shelf renders without a ChampVault call);
"sent?" is derived from whether the rep has a ContentShare of that asset.
"""

from __future__ import annotations

from datetime import datetime
from uuid import uuid4

from sqlalchemy import Column, DateTime, ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship

from app.db.postgres import Base


class Assignment(Base):
    """One leader→rep recommendation of a ChampVault asset."""

    __tablename__ = "assignments"
    __table_args__ = (
        UniqueConstraint(
            "organization_id", "champvault_asset_id", "assigned_to_user_id",
            name="uq_assignment_org_asset_assignee",
        ),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    organization_id = Column(
        UUID(as_uuid=True),
        ForeignKey("organizations.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    champvault_asset_id = Column(String(64), nullable=False, index=True)
    # Snapshot so the rep's shelf renders without a round-trip to ChampVault.
    asset_title = Column(String(255), nullable=True)

    assigned_to_user_id = Column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # Attribution survives the assigner leaving the org.
    assigned_by_user_id = Column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    note = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    assigned_to = relationship("User", foreign_keys=[assigned_to_user_id])
