"""Per-user favorites over the common ChampVault library.

The library in ChampBeam is a thin, read-only view of the external ChampVault
hub. Users don't own those assets, so a favorite is just a lightweight pointer:
"this ChampVault asset is one I keep sending." It powers the personal "My
Favorites" shelf without mirroring any bytes locally.
"""

from __future__ import annotations

from datetime import datetime
from uuid import uuid4

from sqlalchemy import Column, DateTime, ForeignKey, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID

from app.db.postgres import Base


class Favorite(Base):
    """A user's favorite ChampVault asset (one row per user + asset)."""

    __tablename__ = "champvault_favorites"
    __table_args__ = (
        UniqueConstraint("user_id", "champvault_asset_id", name="uq_favorite_user_asset"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    user_id = Column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # The external ChampVault asset id. No FK — ChampVault owns the asset.
    champvault_asset_id = Column(String(64), nullable=False, index=True)

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
